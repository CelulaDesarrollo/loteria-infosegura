import { io, Socket } from "socket.io-client";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

interface PlayerData {
    name: string;
    isOnline: boolean;
    board: number[];
    markedIndices: number[];
}

class GameSocket {
    private socket: Socket;
    private static instance: GameSocket;

    private constructor() {
        this.socket = io(BACKEND, {
            transports: ["websocket"],
            autoConnect: true,
        });
    }

    static getInstance() {
        if (!GameSocket.instance) {
            GameSocket.instance = new GameSocket();
        }
        return GameSocket.instance;
    }

    async joinRoom(roomId: string, playerName: string, playerData: any) {
        await new Promise<void>((resolve) => {
            if (this.socket.connected) resolve();
            else this.socket.once("connect", resolve);
        });

        return new Promise((resolve, reject) => {
            const onJoined = (room: any) => {
                console.log("✅ Evento roomJoined recibido:", room);
                resolve(room);
            };
            const onError = (err: any) => {
                console.error("❌ Error del servidor:", err);
                reject(err);
            };

            this.socket.once("roomJoined", onJoined);
            this.socket.once("error", onError);

            console.log("🛰️ Enviando joinRoom...");
            this.socket.emit("joinRoom", { roomId, playerName, playerData });
        });
    }

    updateGameState(roomId: string, gameState: any) {
        this.socket.emit("updateGame", { roomId, gameState });
    }

    onGameUpdate(callback: (gameState: any) => void): () => void {
        this.socket.on("gameUpdated", callback);
        return () => this.socket.off("gameUpdated", callback);
    }

    onPlayerJoined(
        callback: (data: { playerName: string; playerData: PlayerData }) => void
    ): () => void {
        this.socket.on("playerJoined", callback);
        return () => this.socket.off("playerJoined", callback);
    }

    onPlayerLeft(callback: (data: { playerName: string }) => void): () => void {
        this.socket.on("playerLeft", callback);
        return () => this.socket.off("playerLeft", callback);
    }

    disconnect() {
        this.socket.disconnect();
    }
}

export const gameSocket = GameSocket.getInstance();