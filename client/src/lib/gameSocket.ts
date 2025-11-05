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

    // ahora siempre resolvemos con { success, room?, error? }
    async joinRoom(
        roomId: string,
        playerName: string,
        playerData: any
    ): Promise<{ success: true; room: any } | { success: false; error: any }> {
        await new Promise<void>((resolve) => {
            if (this.socket.connected) resolve();
            else this.socket.once("connect", resolve);
        });

        return new Promise((resolve) => {
            const onJoined = (room: any) => {
                cleanup();
                console.log("✅ Evento roomJoined recibido:", room);
                resolve({ success: true, room });
            };
            const onJoinError = (err: any) => {
                cleanup();
                console.warn("⚠️ joinError recibido:", err);
                resolve({ success: false, error: err || { message: "unknown" } });
            };
            const onError = (err: any) => {
                cleanup();
                console.error("❌ Evento error recibido:", err);
                resolve({ success: false, error: err || { message: "unknown" } });
            };

            const cleanup = () => {
                this.socket.off("roomJoined", onJoined);
                this.socket.off("joinError", onJoinError);
                this.socket.off("error", onError);
            };

            this.socket.once("roomJoined", onJoined);
            this.socket.once("joinError", onJoinError);
            this.socket.once("error", onError);

            console.log("🛰️ Enviando joinRoom...", { roomId, playerName });
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

    leaveRoom(roomId: string, playerName: string) {
        // emitir evento para que el servidor elimine al jugador de la sala sin desconectar el socket
        this.socket.emit("leaveRoom", { roomId, playerName });
    }

    // método genérico para emitir eventos
    emit(event: string, ...args: any[]) {
        this.socket.emit(event, ...args);
    }


    disconnect() {
        this.socket.disconnect();
    }
}

export const gameSocket = GameSocket.getInstance();