import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySocketIO from "fastify-socket.io";
import { Server } from "socket.io";
import { RoomService } from "./services/roomService";
import { Player } from "./types/game";
import { checkWin } from "./services/loteria"; // ✅ AÑADIR ESTE IMPORT
import fastifyStatic from "@fastify/static";
import path from "path";
import { ServerResponse } from "http";

async function startServer() {
  const fastify = Fastify({ logger: true });

  // Token de admin
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin_token_loteria"; // cambia en prod

  // Construir orígenes permitidos según entorno (agrega aquí tus URLs de cliente)
  const PROD_CLIENT = process.env.CLIENT_URL_PROD || "https://loteria-infosegura-d9v8.vercel.app";
  const DEV_CLIENT = process.env.CLIENT_URL_DEV || "http://localhost:9002";
  // URL adicional para administración
  const ADMIN_CLIENT = "https://loteria-infosegura-servidor.vercel.app";
  const EXTRA_DEV = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:9002",
    "http://148.226.24.22",
  ];

  const allowedOrigins = new Set<string>([PROD_CLIENT, DEV_CLIENT, ADMIN_CLIENT, ...EXTRA_DEV]);
  const isDev = process.env.NODE_ENV !== "production";

  // Función de PreHandler de Autenticación
  const authenticateAdmin = (req: any, reply: any, done: () => void) => {
    const token = (req.headers['x-admin-token'] as string) || '';
    if (token !== ADMIN_TOKEN) {
      console.warn(`[Admin] Intento de acceso denegado. Token: ${token}`);
      return reply.code(401).send({ error: 'unauthorized', message: 'Invalid X-Admin-Token' });
    }
    done();
  };

  // Helper para manejar errores de tipo 'unknown'
  const errorToString = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    return String(e);
  };

  // [D] Delete Single Room (Nuevo: Eliminar Sala Completa)
  fastify.route({
    method: 'DELETE',
    url: '/admin/rooms/:roomId',
    preHandler: [authenticateAdmin],
    handler: async (req, reply) => {
      const { roomId } = req.params as any;
      try {
        await RoomService.deleteRoom(roomId);

        // Detener bucle de juego y notificar clientes
        RoomService.stopCallingCards(roomId);
        const io = fastify.io as Server | undefined;
        if (io) {
          io.to(roomId).emit("roomDeleted", { roomId });
        }

        return reply.send({ success: true, message: `Sala ${roomId} y su bucle de juego eliminados.` });
      } catch (e) {
        fastify.log.error({ err: e }, `Error al eliminar sala ${roomId}`);
        return reply.code(500).send({ success: false, error: errorToString(e) });
      }
    }
  });

  // [D] Delete All Players (Nuevo: Limpieza masiva)
  fastify.route({
    method: 'DELETE',
    url: '/admin/players/clear-all',
    preHandler: [authenticateAdmin],
    handler: async (req, reply) => {
      try {
        await RoomService.clearAllPlayers(); // Asumiendo que esta función notifica al cliente si es necesario
        return reply.send({ success: true, message: 'Todos los jugadores históricos han sido eliminados de todas las salas.' });
      } catch (e) {
        fastify.log.error({ err: e }, 'Error en /admin/players/clear-all');
        return reply.code(500).send({ success: false, error: 'Internal Server Error' });
      }
    }
  });

  // --- RUTAS ADMIN (protegidas por header x-admin-token) ---

  // [R] Read All Rooms
  fastify.route({
    method: 'GET',
    url: '/admin/rooms',
    preHandler: [authenticateAdmin],
    handler: async (req, reply) => {
      const list = await RoomService.listRooms();
      return reply.send({ success: true, count: list.length, rooms: list });
    }
  });

  // [R] Read Single Room
  fastify.route({
    method: 'GET',
    url: '/admin/rooms/:roomId',
    preHandler: [authenticateAdmin],
    handler: async (req, reply) => {
      const { roomId } = req.params as any;
      const room = await RoomService.getRoom(roomId);
      if (!room) return reply.code(404).send({ success: false, message: `Sala ${roomId} no encontrada.` });
      return reply.send({ success: true, id: roomId, room });
    }
  });

  // [D] Delete Single Player (Ahora con DELETE y mejor lógica)
  fastify.route({
    method: 'DELETE',
    url: '/admin/rooms/:roomId/players/:playerName',
    preHandler: [authenticateAdmin],
    handler: async (req, reply) => {
      const { roomId, playerName } = req.params as any;
      try {
        await RoomService.removePlayer(roomId, playerName);

        // Notificar por socket si está disponible
        const io = fastify.io as Server | undefined;
        const updated = await RoomService.getRoom(roomId);

        if (io) {
          // Notificar al cliente que el jugador se fue/fue eliminado
          io.to(roomId).emit('playerLeft', { playerName });
          io.to(roomId).emit('roomUpdated', updated);
          if (updated?.gameState) io.to(roomId).emit('gameUpdated', updated.gameState);

          // Desconectar sockets asociados a ese jugador/sala
          io.sockets.sockets.forEach((s: any) => {
            if (s.data?.roomId === roomId && s.data?.playerName === playerName) {
              try { s.disconnect(true); } catch (_) { /* noop */ }
            }
          });
        }

        return reply.send({ success: true, message: `Jugador ${playerName} eliminado de la sala ${roomId}.` });
      } catch (e) {
        fastify.log.error({ err: e }, `Error al eliminar jugador ${playerName} de ${roomId}`);
        return reply.code(500).send({ success: false, error: errorToString(e) });
      }
    }
  });


  // Helper para validar origin in runtime (puedes loguear para depuración)
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

  // Middleware para añadir headers restrictivos a imágenes
  fastify.register(fastifyStatic, {
    root: path.join(__dirname, "../public"),
    prefix: "/cards/",
    constraints: {},
    // headers para prevenir descarga y caché persistente
    // Tipamos `res` como ServerResponse para que TS reconozca setHeader.
    setHeaders: (res: ServerResponse, filePath: string) => {
      if (typeof filePath === "string" && (filePath.endsWith(".png") || filePath.endsWith(".jpg") || filePath.endsWith(".jpeg"))) {
        try {
          // Prevenir que el navegador cache la imagen de forma persistente
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
          // Indicar que no es para descargar
          res.setHeader("Content-Disposition", "inline; filename=restricted");
          // Prevenir acceso de terceros
          res.setHeader("X-Content-Type-Options", "nosniff");
          // Controlar CORS para las imágenes (opcional)
          res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "http://localhost:3000");
        } catch (err) {
          // Loguear con objeto y mensaje para cumplir overloads de pino/fastify.log
          fastify.log.debug({ err: String(err) }, "setHeaders error");
        }
      }
    }
  });

  // usar IIFE async dentro del ready para poder usar await condicionalmente
  fastify.ready((err) => {
    if (err) throw err;
    const io = fastify.io as Server;
    // Tarea periódica para limpiar players inactivos y notificar cambios
    const CLEANUP_INTERVAL = 20_000; // cada 20s
    setInterval(async () => {
      try {
        const changes = await RoomService.cleanupStalePlayers(5_000); // timeout 5s
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
        fastify.log.error({ err: e }, "Error en cleanupStalePlayers");
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
            const room = await RoomService.getRoom(roomId);
            // Si el juego está activo, eliminar inmediatamente al jugador
            // En caso contrario, solo marcar offline (cleanup lo eliminará después)
            if (room?.gameState?.isGameActive) {
              console.log(`🔥 Juego activo: eliminando jugador ${playerName} de sala ${roomId}`);
              await RoomService.removePlayer(roomId, playerName);
            } else {
              // Si no hay juego activo, marcar offline para cleanup eventual
              await RoomService.markPlayerOffline(roomId, playerName);
            }
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
            // permitimos actualizar la mayoría de campos y también calledCardIds
            // (el cliente puede enviar [] para limpiar historial)
            const { deck, ...safeGameState } = payload.gameState;
            room.gameState = {
              ...(room.gameState || {}),
              ...safeGameState // merge general
            };

            // Si viene explicitamente calledCardIds lo aplicamos (incluso si es [])
            if (Object.prototype.hasOwnProperty.call(payload.gameState, "calledCardIds")) {
              room.gameState.calledCardIds = Array.isArray(payload.gameState.calledCardIds)
                ? payload.gameState.calledCardIds
                : [];
            }

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

      // Cliente solicita que el servidor valide una victoria
      socket.on("claimWin", async (roomId: string, playerName: string, payload: any, callback: Function) => {
        console.log("📥 claimWin recibido:", { roomId, playerName, markedCount: payload?.markedIndices?.length });
        try {
          if (!roomId || !playerName) {
            console.warn("❌ claimWin: parámetros inválidos");
            if (typeof callback === 'function') callback({ success: false, error: "invalid_params" });
            return;
          }
          const room = await RoomService.getRoom(roomId);
          if (!room || !room.players) {
            console.warn("❌ claimWin: sala no encontrada");
            if (typeof callback === 'function') callback({ success: false, error: "room_not_found" });
            return;
          }
          const player = room.players[playerName];
          if (!player) {
            console.warn("❌ claimWin: jugador no encontrado");
            if (typeof callback === 'function') callback({ success: false, error: "player_not_found" });
            return;
          }

          const mode = payload?.gameMode || room.gameState?.gameMode || "full";
          const markedIndices = Array.isArray(payload?.markedIndices) ? payload.markedIndices : (player.markedIndices || []);
          const board = payload?.board ?? (player as any)?.board;
          if (!board) {
            console.warn("❌ claimWin: no hay board");
            if (typeof callback === 'function') callback({ success: false, error: "no_board" });
            return;
          }
          const firstCard = payload?.firstCard || null;
          const calledCardIds = Array.isArray(room.gameState?.calledCardIds) ? room.gameState.calledCardIds : [];

          console.log("🔍 Validando victoria:", { playerName, mode, markedCount: markedIndices.length, calledCount: calledCardIds.length });

          // Validar con lógica centralizada (pasando calledCardIds)
          const validWin = checkWin(board, markedIndices, mode, firstCard, calledCardIds);
          console.log(`✓ checkWin(${mode}) = ${validWin}`);
          
          if (!validWin) {
            console.log("❌ checkWin devolvió false para", { playerName, mode, markedIndices: markedIndices.length });
            if (typeof callback === 'function') callback({ success: false, error: "invalid_pattern" });
            return;
          }

          // Si ya existe ganador evitar duplicados
          if (room.gameState?.winner) {
            console.log("⚠️ Ya hay ganador:", room.gameState.winner);
            if (typeof callback === 'function') callback({ success: false, alreadyWinner: true });
            return;
          }

          // 🏆 FIJADOR DE GANADOR (una sola vez)
          console.log(`🏆 ¡${playerName} ganó en ${roomId}! Modo: ${mode}`);
          room.gameState = {
            ...(room.gameState || {}),
            winner: playerName,
            isGameActive: false,
            timestamp: Date.now(),
          };
          
          // Calcular ranking con markedIndices intactos
          const finalRanking = calculateFinalRanking(room.players as Record<string, Player>);
          room.gameState.finalRanking = finalRanking;
          console.log(`📊 Ranking calculado:`, finalRanking);

          // Persistir
          await RoomService.createOrUpdateRoom(roomId, room);
          RoomService.stopCallingCards(roomId);

          // 📡 EMITIR A TODOS EN LA SALA
          io.to(roomId).emit("gameUpdated", room.gameState);
          io.to(roomId).emit("roomUpdated", room);
          
          // ✅ RESPONDER AL CLIENTE (solo una vez)
          if (typeof callback === 'function') {
            callback({ success: true });
          }
          
        } catch (e) {
          console.error("❌ Error en claimWin:", e);
          if (typeof callback === 'function') {
            callback({ success: false, error: String(e) });
          }
        }
      });
    });

    // (removed stray IIFE closure — fastify.ready callback ya está correctamente cerrado arriba)
  }); // <-- cierre correcto de fastify.ready

  // 4️⃣ Iniciar servidor
  await RoomService.clearAllPlayers();
  console.log("Se limpiaron players históricos en la DB.");

  const port = parseInt(process.env.PORT || "3001", 10);
  await fastify.listen({ port, host: "0.0.0.0" });

}

// arranca la función principal
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
// ✅ FIN DEL ARCHIVO (sin código duplicado)


