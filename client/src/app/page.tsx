"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { gameSocket } from "@/lib/gameSocket";
import { generateBoard } from "@/lib/loteria";
import { Header } from "@/components/Header";
import {
    Card,
    CardContent,
    CardHeader,
    CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { BookOpen, Gamepad2, Loader2 } from "lucide-react";
import { RoomFullModal } from "@/components/game/RoomFullModal";
import { NameExistsModal } from "@/components/game/NameExistsModal";

const DEFAULT_ROOM_ID = "main_loteria"; // Sala común
const MAX_PLAYERS = 100; // Límite de jugadores

export default function Home() {
    const [name, setName] = useState("");
    const [showRoomFullModal, setShowRoomFullModal] = useState(false);
    const [showNameExistsModal, setShowNameExistsModal] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    const handleJoinRoom = async (e: React.FormEvent) => {
        e.preventDefault();
        if (isLoading) return;

        if (name.trim()) {
            setIsLoading(true);
            const roomId = DEFAULT_ROOM_ID;
            const playerName = name.trim();

            const playerData = {
                name: playerName,
                isOnline: true,
                board: generateBoard(),
                markedIndices: [],
            };

            const res = await gameSocket.joinRoom(roomId, playerName, playerData);

            if (!res.success) {
                if (res.error.code === "full") {
                    setShowRoomFullModal(true);
                } else if (res.error.code === "name_in_use") {
                    setShowNameExistsModal(true);
                } else {
                    setShowNameExistsModal(true);
                }
                setIsLoading(false);
                return;
            }

            // Navegar a la sala SIN adjuntar el objeto grande en la URL.
            // El estado inicial ya quedó guardado en gameSocket.getLastRoom()
            router.push(`/room/${roomId}?name=${encodeURIComponent(playerName)}`);
        }
    };

    return (
        <div className="flex flex-col min-h-screen bg-background text-foreground">
            <Header />

            <main className="flex-grow container mx-auto p-4 md:p-6 flex items-center justify-center">
                <div className="w-full max-w-md">
                    <Card
                        className="border-2"
                        style={{ borderColor: "hsl(180.85, 61.74%, 22.55%)" }}
                    >
                        <CardHeader className="text-center">
                            <img
                                src="/loteria.png"
                                alt="Lotería Logo"
                                className="h-140 w-360"
                            />
                            <CardDescription className="pt-2 font-lato font-regular">
                                Ingresa tu nombre para unirte a la sala común.
                            </CardDescription>
                        </CardHeader>

                        <CardContent>
                            <form onSubmit={handleJoinRoom} className="space-y-6">
                                <div className="space-y-2">
                                    <Label htmlFor="name" className="text-base">
                                        Nombre
                                    </Label>
                                    <Input
                                        id="name"
                                        value={name}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                            e.target.setCustomValidity(""); // limpia el mensaje previo
                                            setName(e.target.value);
                                        }}
                                        onInvalid={(e: React.FormEvent<HTMLInputElement>) => {
                                            (e.target as HTMLInputElement).setCustomValidity(
                                                "Por favor, ingresa un nombre."
                                            );
                                        }}
                                        placeholder="Ej. El Valiente"
                                        required
                                        className="text-base"
                                    />
                                </div>

                                <Button
                                    type="submit"
                                    className="w-full"
                                    size="lg"
                                    disabled={isLoading}
                                >
                                    {isLoading ? (
                                        <>
                                            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                                            Cargando...
                                        </>
                                    ) : (
                                        <>
                                            <Gamepad2 className="mr-2" />
                                            Entrar a la sala
                                        </>
                                    )}
                                </Button>
                            </form>

                            {/* Glosario */}
                            <div className="my-4 border-t border-muted">
                                <Button
                                    className="w-full"
                                    variant="outline"
                                    size="lg"
                                    onClick={() => router.push("/glosary")}
                                >
                                    <BookOpen className="mr-2" />
                                    Glosario de cartas
                                </Button>
                            </div>

                            {/* Instructivo */}
                            <div className="my-4 border-t border-muted">
                                <Button
                                    className="w-full"
                                    variant="outline"
                                    size="lg"
                                    onClick={() => router.push("/instructions")}
                                >
                                    <img
                                        src="/LoteriaSI-InterfazIconoInstructivo.svg"
                                        alt="Instructivo Icon"
                                        className="h-4 w-4 inline-block mr-2"
                                    />
                                    Instructivo del juego
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </main>

            <footer className="text-center p-4 text-muted-foreground text-sm">
                <div className="flex items-center justify-center gap-2">
                    <img
                        src="/icono-CDC.png"
                        alt="Célula de Desarrollo"
                        className="h-7"
                    />
                    <p>
                        Elaborado por Célula de Desarrollo de Contenidos DGTI Xalapa.
                    </p>
                </div>
            </footer>

            {/* Modales */}
            <RoomFullModal
                open={showRoomFullModal}
                onClose={() => setShowRoomFullModal(false)}
                roomId={DEFAULT_ROOM_ID}
                maxPlayers={MAX_PLAYERS}
            />
            <NameExistsModal
                open={showNameExistsModal}
                onClose={() => setShowNameExistsModal(false)}
            />
        </div>
    );
}
