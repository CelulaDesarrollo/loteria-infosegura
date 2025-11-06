import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySocketIO from "fastify-socket.io";
import { Server } from "socket.io";
import { RoomService } from "./services/roomService";
import { Player } from "./types/game";

async function startServer() {
  const fastify = Fastify({ logger: true });

  // 1️⃣ CORS para endpoints normales
  await fastify.register(fastifyCors, {
    origin: ["http://localhost:3000"],
    credentials: true,
  });

  // 2️⃣ Socket.IO con CORS explícito
  await fastify.register(fastifySocketIO, {
    cors: {
      origin: ["http://localhost:3000"],
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // 3️⃣ Configurar handlers cuando Fastify está listo
  fastify.ready((err) => {
    if (err) throw err;
    const io = fastify.io as Server;

    io.on("connection", (socket) => {
      console.log("Cliente conectado:", socket.id);

      // --- EXISTENTE: joinRoom / leaveRoom / disconnect ---
      socket.on("joinRoom", async ({ roomId, playerName, playerData }) => {
        try {
          console.log("Intento de unión:", { roomId, playerName });
          const result = await RoomService.addPlayer(roomId, playerName, playerData);
          
          if (!result.added) {
            console.log("Unión fallida:", result.reason);
            socket.emit("joinError", {
              code: result.reason || "unknown",
              message: result.reason === "name_exists" ? "El nombre ya existe" : "Sala llena",
            });
            return;
          }

          // Guardar datos en el socket antes de unirse a la sala
          socket.data.roomId = roomId;
          socket.data.playerName = playerName;

          await socket.join(roomId);
          const room = await RoomService.getRoom(roomId);
          console.log("Unión exitosa, sala:", room);

          // Emitir sala actualizada a todos para sincronizar host/players
          io.to(roomId).emit("roomUpdated", room);
          io.to(roomId).emit("gameUpdated", room?.gameState);

          socket.emit("roomJoined", room);
          socket.to(roomId).emit("playerJoined", { playerName, playerData });
        } catch (err) {
          console.error("Error en joinRoom:", err);
          socket.emit("joinError", { code: "server_error", message: "Error al unirse a la sala" });
        }
      });

      socket.on("leaveRoom", async ({ roomId, playerName }) => {
        try {
          console.log("Solicitud de salida:", { roomId, playerName });
          await RoomService.removePlayer(roomId, playerName);
          socket.leave(roomId);

          // Obtener sala actualizada y emitir para que clientes re-hidraten UI (host reassignment)
          const updated = await RoomService.getRoom(roomId);
          io.to(roomId).emit("playerLeft", { playerName });
          io.to(roomId).emit("roomUpdated", updated);
          if (updated?.gameState) io.to(roomId).emit("gameUpdated", updated.gameState);

        } catch (err) {
          console.error("Error en leaveRoom:", err);
        }
      });

      socket.on("disconnect", async () => {
        const roomId = socket.data.roomId;
        const playerName = socket.data.playerName;
        console.log("Cliente desconectado:", socket.id, { roomId, playerName });
        
        if (roomId && playerName) {
          try {
            await RoomService.removePlayer(roomId, playerName);

            // Tras removePlayer, obtener sala y propagar cambios (re-asignación de host, etc.)
            const updated = await RoomService.getRoom(roomId);
            io.to(roomId).emit("playerLeft", { playerName });
            io.to(roomId).emit("roomUpdated", updated);
            if (updated?.gameState) io.to(roomId).emit("gameUpdated", updated.gameState);

          } catch (err) {
            console.error("Error al remover jugador en disconnect:", err);
          }
        }
      });

      // --- NUEVO: manejar actualizaciones de sala / gameState desde cliente ---
      // Cliente emite: socket.emit("updateRoom", roomId, { players?: ..., gameState?: ... })
      socket.on("updateRoom", async (roomId: string, payload: any) => {
        try {
          if (!roomId || !payload) return;
          const room = (await RoomService.getRoom(roomId)) || {
            players: {},
            gameState: {
              host: "",
              isGameActive: false,
              winner: null,
              deck: [],
              calledCardIds: [],
              timestamp: Date.now(),
            }
          };

          // Fusionar players si vienen
          if (payload.players && typeof payload.players === "object") {
            room.players = { ...(room.players || {}), ...payload.players };
          }

          // Fusionar gameState si viene
          if (payload.gameState && typeof payload.gameState === "object") {
            room.gameState = { ...(room.gameState || {}), ...payload.gameState };
          }

          // Si hay ganador o el juego se desactiva, asegurarse de limpiar las marcas
          // así todos los clientes recibirán la sala con markedIndices vacíos.
          const shouldClearMarks =
            room.gameState?.winner != null ||
            (payload.gameState && payload.gameState.isGameActive === false);

          if (shouldClearMarks && room.players) {
            Object.keys(room.players).forEach((k) => {
              room.players[k] = { ...(room.players[k] || {}), markedIndices: [] };
            });
          }

          await RoomService.createOrUpdateRoom(roomId, room);

          // Emitir sólo el gameState (el cliente escucha "gameUpdated")
          io.to(roomId).emit("gameUpdated", room.gameState);
          // Emitir también la sala completa por si otros consumidores la necesitan
          io.to(roomId).emit("roomUpdated", room);
        } catch (err) {
          console.error("Error en updateRoom:", err);
          socket.emit("error", { message: "Error al actualizar sala", detail: String(err) });
        }
      });

      // Soportar formato alterno: socket.emit("updateGame", { roomId, gameState })
      socket.on("updateGame", async (payload: { roomId: string; gameState: any }) => {
        try {
          if (!payload?.roomId || !payload?.gameState) return;
          const roomId = payload.roomId;
          const room = (await RoomService.getRoom(roomId)) || { players: {}, gameState: {} as any };
          room.gameState = { ...(room.gameState || {}), ...payload.gameState };

          // Si hay ganador o el juego se desactiva, limpiar marcas
          const shouldClearMarks =
            room.gameState?.winner != null || payload.gameState.isGameActive === false;
          if (shouldClearMarks && room.players) {
            Object.keys(room.players).forEach((k) => {
              room.players[k] = { ...(room.players[k] || {}), markedIndices: [] };
            });
          }

          await RoomService.createOrUpdateRoom(roomId, room);
          io.to(roomId).emit("gameUpdated", room.gameState);
          io.to(roomId).emit("roomUpdated", room);
        } catch (err) {
          console.error("Error en updateGame:", err);
          socket.emit("error", { message: "Error al actualizar gameState", detail: String(err) });
        }
      });

    });
  });

  // 4️⃣ Iniciar servidor
  await RoomService.clearAllPlayers();
  console.log("Se limpiaron players históricos en la DB.");

  await fastify.listen({ port: 3001, host: "0.0.0.0" });
  console.log("Servidor corriendo en http://localhost:3001");
}

// Ejecutar función principal
startServer().catch((err) => {
  console.error("❌ Error al iniciar el servidor:", err);
  process.exit(1);
});
