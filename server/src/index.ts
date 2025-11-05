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

      socket.on("joinRoom", async ({ roomId, playerName, playerData }) => {
        try {
          const result = await RoomService.addPlayer(roomId, playerName, playerData);
          if (!result.added) {
            socket.emit("joinError", {
              code: result.reason || "unknown",
              message: result.reason === "name_exists" ? "El nombre ya existe" : "Sala llena",
            });
            return;
          }

          socket.data.roomId = roomId;
          socket.data.playerName = playerName;

          socket.join(roomId);
          const room = await RoomService.getRoom(roomId);
          socket.emit("roomJoined", room);
          socket.to(roomId).emit("playerJoined", { playerName, playerData });
        } catch (err) {
          console.error("Error in joinRoom:", err);
          socket.emit("joinError", { code: "server_error", message: "Error al unirse a la sala" });
        }
      });

      socket.on("disconnect", async () => {
        const { roomId, playerName } = socket.data;
        console.log("Cliente desconectado:", socket.id, roomId, playerName);
        if (roomId && playerName) {
          await RoomService.removePlayer(roomId, playerName);
          io.to(roomId).emit("playerLeft", { playerName });
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
