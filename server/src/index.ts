import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySocketIO from "fastify-socket.io";
import { Server } from "socket.io";
import { RoomService } from "./services/roomService";
import { Player } from "./types/game";

async function startServer() {
  const fastify = Fastify({ logger: true });

  const ALLOWED_ORIGINS = [
    // 1. URL de tu cliente desplegado en Vercel
    "https://loteria-infosegura-d9v8.vercel.app",
    // 2. Tu entorno de desarrollo local 
    "http://localhost:3000", // Asegúrate de que el puerto 3000 sea el correcto para tu cliente
    "http://127.0.0.1:3000", // También soporta localhost con IP directa
    "http://localhost:9002"
  ];

  // 1️⃣ CORS para endpoints normales (Fastify)
  await fastify.register(fastifyCors, {
    origin: ALLOWED_ORIGINS,
    credentials: true,
  });

  // 2️⃣ Socket.IO con CORS explícito
  await fastify.register(fastifySocketIO, {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 60000,
    maxHttpBufferSize: 1e6,
  });

  // usar IIFE async dentro del ready para poder usar await condicionalmente
  fastify.ready((err) => {
    if (err) throw err;
    const io = fastify.io as Server;

    // cargado condicional del adapter Redis para no romper compilación si no está instalado
    (async () => {
      if (process.env.REDIS_URL) {
        try {
          // @ts-ignore - módulos dinámicos no se resuelven en compilación
          const { createAdapter } = await import('@socket.io/redis-adapter') as any;
          const { createClient } = await import('redis') as any;
          const pubClient = createClient({ url: process.env.REDIS_URL });
          const subClient = pubClient.duplicate();
          await Promise.all([pubClient.connect(), subClient.connect()]);
          io.adapter(createAdapter(pubClient, subClient));
          fastify.log.info("socket.io: Redis adapter conectado");
        } catch (e) {
          fastify.log.error("No fue posible conectar Redis adapter: " + (e instanceof Error ? e.message : String(e)));
        }
      }

      io.on("connection", (socket) => {
        console.log("Cliente conectado:", socket.id);
        socket.data.roomId = null;
        socket.data.playerName = null;

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

              // Obtener sala actualizada
              const updated = await RoomService.getRoom(roomId);

              // Si ya no quedan jugadores, limpiar completamente la sala
              if (!updated || Object.keys(updated.players || {}).length === 0) {
                console.log(`🧹 Sala ${roomId} vacía, eliminando estado`);
                await RoomService.deleteRoom?.(roomId);
                return;
              }

              io.to(roomId).emit("playerLeft", { playerName });
              io.to(roomId).emit("roomUpdated", updated);
              if (updated?.gameState) io.to(roomId).emit("gameUpdated", updated.gameState);

            } catch (err) {
              console.error("Error al remover jugador en disconnect:", err);
            }
          }
        });


        socket.on("updateRoom", async (roomId: string, payload: any) => {
          try {
            if (!roomId || !payload) return;
            const room = (await RoomService.getRoom(roomId)) || {
              players: {},
              gameState: {
                host: "",
                isGameActive: false,
                winner: null,
                gameMode: "",
                deck: [],
                calledCardIds: [],
                timestamp: Date.now(),
                finalRanking: null,
              }
            };

            // Fusionar players si vienen
            if (payload.players && typeof payload.players === "object") {
              room.players = { ...(room.players || {}), ...payload.players };
            }

            // Fusionar gameState si viene
            if (payload.gameState && typeof payload.gameState === "object") {
              const { deck, calledCardIds, ...safeGameState } = payload.gameState;
              room.gameState = {
                ...(room.gameState || {}),
                ...safeGameState // Solo fusionamos propiedades seguras
              };

              // Si el cliente pide desactivar el juego o hay ganador, paramos el bucle.
              if (safeGameState.isGameActive === false || safeGameState.winner) {
                RoomService.stopCallingCards(roomId);
              }
            }

            // Si hay ganador o el juego se desactiva, asegurarse de limpiar las marcas
            const shouldClearMarks =
              room.gameState?.winner != null ||
              (payload.gameState && payload.gameState.isGameActive === false);

            // Si hay ganador, calcula el ranking con las marcas intactas.
            if (room.gameState?.winner && room.players) {
              const finalRanking = calculateFinalRanking(room.players as Record<string, Player>);
              room.gameState.finalRanking = finalRanking;
              console.log(`🏆 Ranking final calculado para ${roomId}:`, finalRanking);

              // Detener bucle aquí también por si el cliente no mandó isGameActive=false
              RoomService.stopCallingCards(roomId);
            }

            if (shouldClearMarks && room.players && typeof room.players === "object") {
              const players = room.players as Record<string, Player>;
              Object.keys(players).forEach((k: string) => {
                const current = players[k] || ({} as Player);
                // Limpiar las marcas después de haber guardado el ranking
                players[k] = { ...current, markedIndices: [] };
              });
              room.players = players;
            }

            await RoomService.createOrUpdateRoom(roomId, room);

            // Emitir sólo el gameState (el cliente escucha "gameUpdated")
            io.to(roomId).emit("gameUpdated", room.gameState);
            // Emitir también la sala completa por si otros consumidores la necesitan
            io.to(roomId).emit("roomUpdated", room);
            if (shouldClearMarks) {
              const players = room.players as Record<string, Player>;
              Object.keys(players).forEach((pName: string) => {
                // Emitimos el evento que el cliente usa para actualizar un solo jugador
                io.to(roomId).emit("playerJoined", { playerName: pName, playerData: players[pName] });
              });
            }
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
            const room = (await RoomService.getRoom(roomId)) || { players: {} as Record<string, Player>, gameState: {} as any };
            room.gameState = { ...(room.gameState || {}), ...payload.gameState };

            const { deck, calledCardIds, ...safeGameState } = payload.gameState;
            room.gameState = {
              ...(room.gameState || {}),
              ...safeGameState // Solo fusionamos propiedades seguras
            };

            // Si el cliente pide desactivar el juego o hay ganador, paramos el bucle.
            if (safeGameState.isGameActive === false || safeGameState.winner) {
              RoomService.stopCallingCards(roomId);
            }

            // Si hay ganador o el juego se desactiva, limpiar marcas
            const shouldClearMarks =
              room.gameState?.winner != null || payload.gameState.isGameActive === false;

            // Si hay ganador, calcula el ranking con las marcas intactas.
            if (room.gameState?.winner && room.players) {
              const finalRanking = calculateFinalRanking(room.players as Record<string, Player>);
              room.gameState.finalRanking = finalRanking;
              console.log(`🏆 Ranking final calculado (updateGame) para ${roomId}:`, finalRanking);

              // Detener bucle aquí también por si el cliente no mandó isGameActive=false
              RoomService.stopCallingCards(roomId);
            }

            if (shouldClearMarks && room.players) {
              Object.keys(room.players).forEach((k) => {
                const players = room.players as Record<string, Player>;
                // Limpiar las marcas después de haber guardado el ranking
                players[k] = { ...(players[k] || {}), markedIndices: [] };
              });
            }

            await RoomService.createOrUpdateRoom(roomId, room);
            io.to(roomId).emit("gameUpdated", room.gameState);
            io.to(roomId).emit("roomUpdated", room);

            if (shouldClearMarks) {
              const players = room.players as Record<string, Player>;
              Object.keys(players).forEach((pName: string) => {
                // Emitimos el evento que el cliente usa para actualizar un solo jugador
                io.to(roomId).emit("playerJoined", { playerName: pName, playerData: players[pName] });
              });
            }
          } catch (err) {
            console.error("Error en updateGame:", err);
            socket.emit("error", { message: "Error al actualizar gameState", detail: String(err) });
          }
        });

        socket.on("startGameLoop", async (roomId: string, gameMode: string) => {
          try {
            console.log(`➡️ Inicializando juego y bucle de llamadas para sala ${roomId} en modo ${gameMode}`);

            // 1. Inicializa el juego (barajar mazo, limpiar marcas)
            const initialRoom = await RoomService.initializeGame(roomId, gameMode);

            // 2. Inicia el bucle de llamadas automáticas (startCallingCards ya ejecuta la primera llamada)
            await RoomService.startCallingCards(roomId, io);

            // Emitir la sala actualizada (gameUpdated ya es emitido por startCallingCards/callNextCard)
            const updated = await RoomService.getRoom(roomId);
            io.to(roomId).emit("roomUpdated", updated);
          } catch (err) {
            console.error("Error en startGameLoop:", err);
            socket.emit("error", { message: "Error al iniciar juego" });
          }
        });

        socket.on("stopGameLoop", async (roomId: string) => {
          try {
            console.log(`⏹️ Deteniendo bucle de cartas para sala ${roomId}`);
            await RoomService.stopCallingCards(roomId);
            const updated = await RoomService.getRoom(roomId);
            io.to(roomId).emit("roomUpdated", updated);
            io.to(roomId).emit("gameUpdated", updated?.gameState);
          } catch (err) {
            console.error("Error en stopGameLoop:", err);
            socket.emit("error", { message: "Error al detener juego" });
          }
        });
      });

    })().catch((e) => {
      console.error("Error en inicialización async dentro de fastify.ready:", e);
      throw e;
    });
  });

  // 4️⃣ Iniciar servidor
  await RoomService.clearAllPlayers();
  console.log("Se limpiaron players históricos en la DB.");

  // ⭐ CORRECCIÓN CLAVE: Usar process.env.PORT
  const port = parseInt(process.env.PORT || '3001', 10);
  await fastify.listen({ port, host: "0.0.0.0" });

  console.log(`Servidor corriendo en http://localhost:${port}`); // Actualiza el mensaje
}

// Ejecutar función principal
startServer().catch((err) => {
  console.error("❌ Error al iniciar el servidor:", err);
  process.exit(1);
});
