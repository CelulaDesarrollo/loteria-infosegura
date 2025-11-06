"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useParams, useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { LoteriaGame } from "@/components/game/LoteriaGame";
import { gameSocket } from "@/lib/gameSocket";

export default function RoomPage() {
    const searchParams = useSearchParams();
    const params = useParams();
    const router = useRouter();

    const name = searchParams.get('name');
    const initialRoom = searchParams.get('initialRoom');
    const roomId = params.id as string;

    const [roomData, setRoomData] = useState<any | null>(() => {
        try {
            return initialRoom ? JSON.parse(initialRoom) : null;
        } catch {
            return null;
        }
    });
    const [loading, setLoading] = useState(!initialRoom);

    // Solo suscribirse a actualizaciones, no unirse de nuevo
    useEffect(() => {
        if (!roomId || !name) return;

        // Si no venimos con initialRoom en la URL, intentar obtener el último estado
        if (!roomData) {
            const last = gameSocket.getLastRoom?.();
            if (last) {
                setRoomData(last);
                setLoading(false);
            } else {
                // si tampoco hay lastRoom, suscribirse una vez a roomJoined para recibirlo
                const unsubRoom = gameSocket.onRoomJoined((room) => {
                    setRoomData(room);
                    setLoading(false);
                });
                // cleanup al desmontar
                return () => {
                    unsubRoom();
                };
            }
        }

        const unsubscribeUpdate = gameSocket.onGameUpdate((newState) => {
            setRoomData(prev => ({...prev, gameState: newState}));
        });

        const unsubscribeJoin = gameSocket.onPlayerJoined(({playerName, playerData}) => {
            setRoomData(prev => ({
                ...prev,
                players: {
                    ...(prev?.players || {}),
                    [playerName]: playerData
                }
            }));
        });

        const unsubscribeLeft = gameSocket.onPlayerLeft(({playerName}) => {
            setRoomData(prev => {
                if (!prev?.players) return prev;
                const newPlayers = {...prev.players};
                delete newPlayers[playerName];
                return {...prev, players: newPlayers};
            });
        });

        return () => {
            unsubscribeUpdate();
            unsubscribeJoin();
            unsubscribeLeft();
            if (roomId && name) {
                gameSocket.leaveRoom(roomId, name);
            }
        };
    }, [roomId, name]);

    // Si no hay nombre o datos iniciales, redirige a la página principal
    useEffect(() => {
        if (!name || (!loading && !roomData)) {
            router.replace("/");
        }
    }, [name, loading, roomData, router]);

    if (loading || !name || !roomData || !roomData.players || !roomData.players[name]) {
        return (
            <div className="flex flex-col items-center justify-center h-64">
                <p className="text-lg text-muted-foreground">Cargando sala, un momento...</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col min-h-screen bg-background text-foreground">
            <Header />
            <main className="flex-grow container mx-auto p-4 md:p-6">
                <LoteriaGame
                    roomId={roomId}
                    playerName={name}
                    roomData={roomData}
                />
            </main>
        </div>
    );
}