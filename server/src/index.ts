import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySocketIO from "fastify-socket.io";
import { Server } from "socket.io";
import { RoomService } from "./services/roomService";
import { Player } from "./types/game";

async function startServer() {
  const fastify = Fastify({ logger: true });

  // Construir orígenes permitidos según entorno (agrega aquí tus URLs de cliente)
  const PROD_CLIENT = process.env.CLIENT_URL_PROD || "https://loteria-infosegura-d9v8.vercel.app";
  const DEV_CLIENT = process.env.CLIENT_URL_DEV || "http://localhost:9002";
  const EXTRA_DEV = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:9002",
  ];

  const allowedOrigins = new Set<string>([PROD_CLIENT, DEV_CLIENT, ...EXTRA_DEV]);
  const isDev = process.env.NODE_ENV !== "production";

  // Helper para validar origin en runtime (puedes loguear para depuración)
  const originValidator = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true); // allow non-browser tools / same-origin/no-origin (e.g. mobile native, curl)
    if (allowedOrigins.has(origin)) return cb(null, true);
    // En desarrollo puedes permitir todo temporalmente (opcional)
    if (isDev) {
      console.warn("[CORS] origin not in allowlist, allowing in dev:", origin);
      return cb(null, true);
    }
    cb(new Error("Not allowed by CORS"), false);
  };

  // Para referencia/depuración imprime lista de orígenes permitidos
  console.log("CORS allowed origins:", Array.from(allowedOrigins));

  // 1️⃣ CORS para endpoints normales (Fastify)
  await fastify.register(fastifyCors, {
    // casteo a any para evitar conflictos de firma entre versiones de tipos
    origin: originValidator as any,
    credentials: true,
  });

  // 2️⃣ Socket.IO con CORS explícito
  await fastify.register(fastifySocketIO, {
    cors: {
      // casteo a any para evitar conflicto de tipos con la firma esperada por socket.io/factory
      origin: originValidator as any,
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
    // Tarea periódica para limpiar players inactivos y notificar cambios
    const CLEANUP_INTERVAL = 30_000; // cada 30s
    setInterval(async () => {
      try {
        const changes = await RoomService.cleanupStalePlayers(90_000); // timeout 90s
        for (const ch of changes) {
          if (!ch.room) {
            // sala eliminada
            io.to(ch.roomId).emit("roomDeleted", { roomId: ch.roomId });
          } else {
            io.to(ch.roomId).emit("roomUpdated", ch.room);
            if (ch.room.gameState) io.to(ch.roomId).emit("gameUpdated", ch.room.gameState);
          }
        }
      } catch (e) {
        fastify.log.error("Error en cleanupStalePlayers:", e);
      }
    }, CLEANUP_INTERVAL);

    io.on("connection", (socket) => {
      console.log("Cliente conectado:", socket.id);
      socket.data.roomId = null;
      socket.data.playerName = null;

      // presencia explícita desde cliente para actualizar lastSeen/isOnline
      socket.on("presence", async ({ roomId, playerName }: { roomId: string; playerName: string }) => {
        try {
          if (roomId && playerName) await RoomService.markPlayerActive(roomId, playerName);
        } catch (err) {
          console.error("presence handler error:", err);
        }
      });

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
          // marcar activo al unirse
          await RoomService.markPlayerActive(roomId, playerName);
          // emitir playerJoined ya hace roomUpdated/gameUpdated
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
            // marcar offline y dejar que cleanup elimine si es necesario
            await RoomService.markPlayerOffline(roomId, playerName);
            // obtener sala actualizada y emitir (si sigue existiendo)
            const updated = await RoomService.getRoom(roomId);
            if (!updated || Object.keys(updated.players || {}).length === 0) {
              // si ya no hay players, deleteRoom se encargará en cleanup; opcionalmente borrar ahora
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

          // Guardar: si ya hay juego activo no reiniciamos (evitar duplicados)
          const existing = await RoomService.getRoom(roomId);
          if (existing?.gameState?.isGameActive) {
            console.log(`startGameLoop ignorado para ${roomId}: juego ya activo.`);
            return;
          }

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
  }); // <-- cierre correcto de fastify.ready

  // 4️⃣ Iniciar servidor: limpiar players históricos y levantar listener
  await RoomService.clearAllPlayers();
  console.log("Se limpiaron players históricos en la DB.");

  const port = parseInt(process.env.PORT || "3001", 10);
  await fastify.listen({ port, host: "0.0.0.0" });

} // <-- cierre de la función startServer

// arranca la función principal y captura errores
startServer().catch((err) => {
  console.error("❌ Error al iniciar el servidor:", err);
  process.exit(1);
});

// Helper: calcular ranking final basado en markedIndices actuales
const calculateFinalRanking = (players: any) => {
  return Object.values(players || {})
    .map((p: any) => ({
      name: p.name,
      seleccionadas: Array.isArray(p.markedIndices) ? p.markedIndices.length : 0,
    }))
    .sort((a, b) => b.seleccionadas - a.seleccionadas);
};
