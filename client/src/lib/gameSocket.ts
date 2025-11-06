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
    private isConnecting: boolean = false;
    private connectionPromise: Promise<void> | null = null;

    private constructor() {
        this.socket = io(BACKEND, {
            transports: ["websocket"],
            autoConnect: false,
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: 5
        });
    }

    static getInstance() {
        if (!GameSocket.instance) {
            GameSocket.instance = new GameSocket();
        }
        return GameSocket.instance;
    }

    private async ensureConnection(): Promise<void> {
        if (this.socket.connected) return;
        
        if (this.isConnecting) {
            return this.connectionPromise!;
        }

        this.isConnecting = true;
        this.connectionPromise = new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                this.socket.off('connect', onConnect);
                this.isConnecting = false;
                resolve();
            }, 5000);

            const onConnect = () => {
                clearTimeout(timeout);
                this.socket.off('connect', onConnect);
                this.isConnecting = false;
                resolve();
            };

            this.socket.once('connect', onConnect);
            this.socket.connect();
        });

        return this.connectionPromise;
    }

    async joinRoom(
        roomId: string,
        playerName: string,
        playerData: any
    ): Promise<{ success: true; room: any } | { success: false; error: any }> {
        await this.ensureConnection();

        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                cleanup();
                resolve({ success: false, error: { message: "Timeout al unirse" } });
            }, 5000);

            const cleanup = () => {
                clearTimeout(timeoutId);
                this.socket.off("roomJoined", onJoined);
                this.socket.off("joinError", onError);
                this.socket.off("error", onError);
            };

            const onJoined = (room: any) => {
                cleanup();
                console.log("✅ Unión exitosa:", room);
                resolve({ success: true, room });
            };

            const onError = (err: any) => {
                cleanup();
                console.warn("⚠️ Error al unirse:", err);
                resolve({ success: false, error: err });
            };

            this.socket.once("roomJoined", onJoined);
            this.socket.once("joinError", onError);
            this.socket.once("error", onError);

            console.log("🔄 Enviando joinRoom:", { roomId, playerName });
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