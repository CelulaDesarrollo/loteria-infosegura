"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { BookOpen, Gamepad2, ClipboardPen } from "lucide-react";
import { getRoom, setRoom, updateRoom } from "@/lib/firebaseRoom";
import { generateBoard } from "@/lib/loteria";
import { ref, onDisconnect } from "firebase/database";
import { database } from "@/lib/firebase";
import { RoomFullModal } from "@/components/game/RoomFullModal"; // <-- añadido

const DEFAULT_ROOM_ID = "main_loteria"; // sala única para todos

export default function Home() {
  const [name, setName] = useState("");
  const [showRoomFullModal, setShowRoomFullModal] = useState(false);
  const MAX_PLAYERS = 25; // Límite de jugadores por sala

  const router = useRouter();

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      const roomId = DEFAULT_ROOM_ID;
      const playerName = name.trim();
      const roomData = await getRoom(roomId);

      // valida límite de jugadores si la sala existe
      const playersObj = roomData?.players ?? {};
      const currentCount = Object.keys(playersObj).length;
      if (currentCount >= MAX_PLAYERS) {
        setShowRoomFullModal(true);
        return;
      }

      // valida nombre duplicado
      if (roomData && roomData.players && roomData.players[playerName]) {
        alert("Ya existe un jugador con ese nombre en la sala. Elige otro.");
        return;
      }

      // Si la sala no existe, créala
      if (!roomData) {
        await setRoom(roomId, {
          players: {
            [playerName]: {
              name: playerName,
              isOnline: true,
              board: generateBoard(),
              markedIndices: []
            }
          },
          gameState: {
            host: playerName,
            isGameActive: false,
            winner: null,
            deck: [],
            calledCardIds: [],
            timestamp: Date.now()
          }
        });
      } else {
        // Si existe, agrega el jugador con board y markedIndices
        const newHost = roomData.gameState?.host || playerName;
        await updateRoom(roomId, {
          players: {
            ...roomData.players,
            [playerName]: {
              name: playerName,
              isOnline: true,
              board: generateBoard(),
              markedIndices: []
            }
          },
          gameState: {
            ...roomData.gameState,
            host: newHost,
          }
        });
      }

      router.push(`/room/${roomId}?name=${encodeURIComponent(playerName)}`);
    }
  };

  useEffect(() => {
    const playerName = name.trim();
    if (playerName) {
      const playerRef = ref(database, `rooms/${DEFAULT_ROOM_ID}/players/${playerName}`);
      // Elimina al jugador si se desconecta (funciona incluso si se apaga la compu)
      onDisconnect(playerRef).remove();
    }
  }, [name]);

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <Header />
      <main className="flex-grow container mx-auto p-4 md:p-6 flex items-center justify-center">
        <div className="w-full max-w-md">
          <Card className="border-2" style={{ borderColor: "hsl(180.85, 61.74%, 22.55%)" }}>
            <CardHeader className="text-center">
              <img src="/loteria.png" alt="Lotería Logo" className="h-140 w-360" />
              <CardDescription className="pt-2 font-lato font-regular">Ingresa tu nombre para unirte a la sala común.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleJoinRoom} className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-base">Nombre</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ej. El Valiente"
                    required
                    className="text-base"
                  />
                </div>

                <Button type="submit" className="w-full" size="lg">
                  <Gamepad2 className="mr-2" />
                  Entrar a la sala
                </Button>

              </form>
              {/* Botón para Glosario, fuera del form para redirigirte */}
              <div className="my-4 border-t border-muted">
                <Button className="w-full" variant="outline" size="lg" onClick={() => router.push("/glosary")}>
                  <BookOpen className="mr-2" />
                  Glosario de cartas
                </Button>
              </div>

              {/* Botón para Instructivo */}
              <div className="my-4 border-t border-muted">
                <Button className="w-full" variant="outline" size="lg" onClick={() => router.push("/instructions")}>
                  <img src="/LoteriaSI-InterfazIconoInstructivo.svg" alt="Instructivo Icon" className="h-4 w-4 inline-block mr-2" /> 
                  Instructivo del juego
                </Button>
              </div>

            </CardContent>
          </Card>
        </div>
      </main>

      {/* Footer fijo al final de la página */}
      <footer className="text-center p-4 text-muted-foreground text-sm">
        <div className="flex items-center justify-center gap-2">
          <img src="/icono-CDC.png" alt="Célula de Desarrollo" className="h-7 " />
          <p>Elaborado por Célula de Desarrollo de Contenidos DGTI Xalapa.</p>
        </div>
      </footer>
      {/* Modal de sala llena */}
      <RoomFullModal
        open={showRoomFullModal}
        onClose={() => setShowRoomFullModal(false)}
        roomId={DEFAULT_ROOM_ID}
        maxPlayers={MAX_PLAYERS}
      />
    </div>
  );
}