import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";

const BACKEND = "https://loteria-infosegura-server.onrender.com"; // link para render
// const BACKEND = "https://loteria-infosegura-production.up.railway.app"; // link para railway ()

interface PlayerData {
    name: string;
    isOnline: boolean;
    board: any;
    markedIndices?: number[];
}

class GameSocket {
    private socket!: Socket;
    private static instance: GameSocket;
    private connecting: boolean = false;
    private lastRoom: any = null;

    private constructor() {
        this.socket = io(BACKEND, {
            transports: ["websocket"],
            autoConnect: false,
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
        });

        // Mantener lastRoom actualizado y propagar eventos
        this.socket.on("roomJoined", (room: any) => {
            this.lastRoom = room;
        });

        this.socket.on("connect", () => {
            console.debug("[gameSocket] connected", this.socket.id);
        });

        this.socket.on("disconnect", (reason: string) => {
            console.debug("[gameSocket] disconnected", reason);
        });
    }

    static getInstance() {
        if (!GameSocket.instance) {
            GameSocket.instance = new GameSocket();
        }
        return GameSocket.instance;
    }

    getLastRoom() {
        return this.lastRoom;
    }

    onRoomJoined(cb: (room: any) => void) {
        this.socket.on("roomJoined", cb);
        return () => this.socket.off("roomJoined", cb);
    }

    onGameUpdate(callback: (state: any) => void) {
        this.socket.on("gameUpdated", callback);
        return () => this.socket.off("gameUpdated", callback);
    }

    onRoomUpdate(callback: (room: any) => void) {
        this.socket.on("roomUpdated", callback);
        return () => this.socket.off("roomUpdated", callback);
    }

    onPlayerJoined(cb: (payload: { playerName: string; playerData: PlayerData }) => void) {
        this.socket.on("playerJoined", cb);
        return () => this.socket.off("playerJoined", cb);
    }

    onPlayerLeft(cb: (payload: { playerName: string }) => void) {
        this.socket.on("playerLeft", cb);
        return () => this.socket.off("playerLeft", cb);
    }

    async ensureConnection(timeoutMs = 5000): Promise<void> {
        if (this.socket.connected) return;
        if (this.connecting) {
            // wait until it's connected or timeout
            await new Promise<void>((resolve) => {
                const check = () => {
                    if (this.socket.connected) {
                        clearInterval(interval);
                        resolve();
                    }
                };
                const interval = setInterval(check, 100);
                setTimeout(() => {
                    clearInterval(interval);
                    resolve();
                }, timeoutMs);
            });
            return;
        }

        this.connecting = true;
        this.socket.connect();

        await new Promise<void>((resolve) => {
            const onConnect = () => {
                this.socket.off("connect", onConnect);
                this.connecting = false;
                resolve();
            };
            this.socket.once("connect", onConnect);

            setTimeout(() => {
                this.socket.off("connect", onConnect);
                this.connecting = false;
                resolve();
            }, timeoutMs);
        });
    }

    async joinRoom(roomId: string, playerName: string, playerData: PlayerData) {
        await this.ensureConnection();
        return new Promise<{ success: boolean; room?: any; error?: any }>((resolve) => {
            const onJoined = (room: any) => {
                cleanup();
                this.lastRoom = room;
                resolve({ success: true, room });
            };
            const onError = (err: any) => {
                cleanup();
                resolve({ success: false, error: err });
            };
            const cleanup = () => {
                this.socket.off("roomJoined", onJoined);
                this.socket.off("joinError", onError);
                this.socket.off("error", onError);
            };

            this.socket.once("roomJoined", onJoined);
            this.socket.once("joinError", onError);
            this.socket.once("error", onError);

            this.socket.emit("joinRoom", { roomId, playerName, playerData });
        });
    }

    async leaveRoom(roomId: string, playerName: string) {
        try {
            await this.ensureConnection();
            this.socket.emit("leaveRoom", { roomId, playerName });
            this.lastRoom = null;
        } catch (e) {
            // ignore
        }
    }

    // Wrapper simple para emitir; espera conexión y resuelve inmediatamente después de emitir.
    async emit(event: string, ...args: any[]) {
        await this.ensureConnection();
        try {
            this.socket.emit(event, ...args);
        } catch (e) {
            console.error("[gameSocket] emit error", e);
            throw e;
        }
    }
}

export const gameSocket = GameSocket.getInstance();