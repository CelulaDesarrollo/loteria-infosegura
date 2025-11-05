const { io } = require("socket.io-client");

const URL = "http://localhost:3001";
const socket = io(URL, { transports: ["websocket"] });

socket.on("connect", () => {
  console.log("conectado:", socket.id);
  socket.emit("joinRoom", {
    roomId: "main_loteria",
    playerName: "tester_" + Math.floor(Math.random() * 10000),
    playerData: {
      name: "tester",
      isOnline: true,
      board: [],
      markedIndices: []
    }
  });
});

socket.on("roomJoined", (data) => console.log("roomJoined:", data));
socket.on("playerJoined", (data) => console.log("playerJoined:", data));
socket.on("error", (err) => console.log("error:", err));
socket.on("disconnect", () => console.log("desconectado"));