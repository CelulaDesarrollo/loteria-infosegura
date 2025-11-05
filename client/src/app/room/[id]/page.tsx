"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useParams, useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { LoteriaGame } from "@/components/game/LoteriaGame";
import { gameSocket } from "@/lib/gameSocket"; // Importar gameSocket

export default function RoomPage() {
  const searchParams = useSearchParams();
  const params = useParams();
  const router = useRouter();

  const name = searchParams.get('name');
  const roomId = params.id as string;

  const [roomData, setRoomData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!roomId) return;

    // Unirse a la sala usando gameSocket
    gameSocket.joinRoom(roomId, name, { name, isOnline: true })
      .then((response) => {
        if (response.success) {
          setRoomData(response.room);
          setLoading(false);
        } else {
          router.replace("/");
        }
      });

    return () => {
      gameSocket.disconnect(); // Desconectar al salir
    };
  }, [roomId, name, router]);

  // Si no hay nombre, redirige a la página principal
  useEffect(() => {
    if (!name) {
      router.replace("/");
    }
  }, [name, router]);

  // Si la sala no existe o no tiene jugadores, redirige a Home
  useEffect(() => {
    if (!loading && (!roomData || !roomData.players || !name || !roomData.players[name])) {
      router.replace("/");
    }
  }, [loading, roomData, name, router]);

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