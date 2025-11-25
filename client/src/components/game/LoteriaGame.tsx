"use client";
import React, { useState, useEffect, useRef } from "react";
import { GameBoard } from "./GameBoard";
import { DealerDisplay } from "./DealerDisplay";
import { WinnerModal } from "./WinnerModal";
import { Button } from "@/components/ui/button";
import { Card as CardType, generateBoard, checkWin, CARDS } from "@/lib/loteria";
import { Play, RotateCw, LogOut, Volume2, VolumeOff } from "lucide-react";
import { PlayerList } from "./PlayerList";
import { gameSocket } from "@/lib/gameSocket";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { IdleModal } from "./IdleModal";
import { getRestriction } from "@/lib/loteria";
import { cantarCarta, cantarCartaConAudio } from "@/lib/cantadito";
import { ModeRequiredModal } from "./ModeRequiredModal"; // <-- añadido
import { ConfirmExitModal } from "./ConfirmExitModal";

import { ResponsiveScale } from "@/components/ResponsiveScale";

interface LoteriaGameProps {
  roomId: string;
  playerName: string;
  roomData: any;
}

const GAME_MODE_LABELS: Record<string, string> = {
  full: "Tradicional",
  horizontal: "Filas",
  vertical: "Columnas",
  diagonal: "Diagonales",
  corners: "Esquinas",
  square: "Cuadrado",
};

export function LoteriaGame({ roomId, playerName, roomData: initialRoomData }: LoteriaGameProps) {
  const [ranking, setRanking] = useState<{ name: string; seleccionadas: number }[]>([]);
  const [roomData, setRoomData] = useState<any>(initialRoomData);

  // selectedMode debe declararse antes de usarlo (evita ReferenceError)
  // Inicializar desde initialRoomData si ya viene del servidor
  const [selectedMode, setSelectedMode] = useState<string>(() => {
    try {
      return initialRoomData?.gameState?.gameMode || "";
    } catch {
      return "";
    }
  });

  // Evita recomputar ranking después de limpiar markedIndices
  const lastWinnerRef = useRef<string | null>(null);

  const gameState = roomData?.gameState ?? null;
  const allPlayers = roomData?.players ?? {};
  const rawPlayer = allPlayers[playerName];
  const player = rawPlayer
    ? { ...rawPlayer, markedIndices: Array.isArray(rawPlayer.markedIndices) ? rawPlayer.markedIndices : [] }
    : undefined;
  // isHost ahora es un estado reactivo que se actualiza cuando cambia gameState.host
  const [isHostState, setIsHostState] = useState(false);
  
  // Efecto para actualizar isHostState cuando cambia el host en gameState
  useEffect(() => {
    const newIsHost = gameState?.host === playerName;
    setIsHostState(newIsHost);
    // Log para debugging
    if (newIsHost && !isHostState) {
      console.log(`✅ ${playerName} ahora es el anfitrión`);
    }
  }, [gameState?.host, playerName]);

  const isHost = isHostState;
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  // Restricciones de marcado según modo de juego
  const [firstCard, setFirstCard] = useState<{ row: number; col: number } | null>(null);
  // Estado que indica que el juego terminó (ganador o mazo agotado)
  const gameEnded = !!gameState && (gameState.winner != null || gameState.isGameActive === false || (Array.isArray(gameState.finalRanking) && gameState.finalRanking.length > 0));

  // Manejo de inactividad
  const [lastActivity, setLastActivity] = useState(Date.now());
  const [showIdleModal, setShowIdleModal] = useState(false);

  // Cantadito
  const [cantaditoActivo, setCantaditoActivo] = useState(false);

  const [showModeModal, setShowModeModal] = useState(false); // <-- añadido
  const [showExitModal, setShowExitModal] = useState(false);

  // Suscribirse a actualizaciones
  useEffect(() => {
    const unsubscribeUpdate = gameSocket.onGameUpdate((newState) => {
      setRoomData((prev: any) => ({ ...prev, gameState: newState }));
    });

    const unsubscribeRoom = gameSocket.onRoomUpdate((room) => {
      setRoomData(room);
    });

    const unsubscribeJoin = gameSocket.onPlayerJoined(({ playerName, playerData }) => {
      setRoomData((prev: any) => ({
        ...(prev || {}),
        players: {
          ...(prev?.players || {}),
          [playerName]: playerData
        }
      }));
    });

    const unsubscribeLeft = gameSocket.onPlayerLeft(({ playerName }) => {
      setRoomData((prev: any) => {
        const newPlayers = { ...(prev?.players || {}) };
        delete newPlayers[playerName];
        return { ...(prev || {}), players: newPlayers };
      });
    });

    // Limpieza al desmontar
    return () => {
      unsubscribeUpdate();
      unsubscribeRoom();
      unsubscribeJoin();
      unsubscribeLeft();
    };
  }, []);

  // Evitar warning aria-hidden: quitar foco antes de abrir modal de ganador
  useEffect(() => {
    if (roomData?.gameState?.winner) {
      try {
        if (document && document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      } catch (e) {
        /* noop */
      }
    }
  }, [roomData?.gameState?.winner]);

  // Marcar carta
  const handleCardClick = async (card: CardType, index: number) => {
    if (!player || !gameState?.isGameActive) return;

    const updatedIndices = Array.isArray(player.markedIndices)
      ? [...player.markedIndices]
      : [];

    const alreadyMarked = updatedIndices.includes(index);
    if (alreadyMarked) {
      // Desmarcar
      updatedIndices.splice(updatedIndices.indexOf(index), 1);
      // Si desmarcamos la carta que fue la primera carta, limpiamos firstCard
      if (firstCard) {
        const firstIdx = firstCard.row * 4 + firstCard.col;
        if (firstIdx === index) setFirstCard(null);
      }
    } else {
      // Marcar
      updatedIndices.push(index);
    }

    // Si aún no hay firstCard y el modo requiere fijar una carta inicial, setearla
    const row = Math.floor(index / 4);
    const col = index % 4;
    if (!firstCard && effectiveMode && effectiveMode !== "full") {
      setFirstCard({ row, col });
    }

    try {
      // 1️⃣ Actualizar localmente primero (optimistic update)
      setRoomData((prev: any) => ({
        ...prev,
        players: {
          ...(prev?.players || {}),
          [playerName]: {
            ...(prev?.players?.[playerName] || {}),
            markedIndices: updatedIndices,
          },
        },
      }));

      // 2️⃣ Emitir al servidor SIN esperar (fire and forget para no bloquear claimWin)
      gameSocket.updateRoom?.(roomId, {
        players: {
          ...(roomData?.players || {}),
          [playerName]: {
            ...(roomData?.players?.[playerName] || {}),
            markedIndices: updatedIndices,
          },
        },
      }).catch(e => console.warn("updateRoom error:", e));

      // 3️⃣ Validar victoria INMEDIATAMENTE (sin esperar updateRoom)
      const modeForCheck = effectiveMode || "full";
      const firstForCheck = firstCard || (modeForCheck !== "full" ? { row, col } : null);

      console.log("📤 EMITIENDO claimWin:", {
        roomId,
        playerName,
        boardLength: player.board.length,
        markedIndices: updatedIndices,
        markedCount: updatedIndices.length,
        gameMode: modeForCheck,
        firstCard: firstForCheck,
        calledCardIds: gameState.calledCardIds,
      });

      try {
        const claimResult = await gameSocket.emit(
          "claimWin",
          roomId,
          playerName,
          {
            board: player.board,
            markedIndices: updatedIndices,
            gameMode: modeForCheck,
            firstCard: firstForCheck,
          }
        );
        console.log("✅ RESPUESTA claimWin:", claimResult);
        if (claimResult?.success) {
          console.log("🎉 VICTORIA CONFIRMADA POR SERVIDOR");
        }
      } catch (claimErr) {
        console.error("❌ Error emitiendo claimWin:", claimErr);
      }
    } catch (err) {
      console.error("Error en handleCardClick:", err);
      // Revertir si falla (rollback)
      setRoomData((prev: any) => ({
        ...prev,
        players: {
          ...(prev?.players || {}),
          [playerName]: {
            ...(prev?.players?.[playerName] || {}),
            markedIndices: player.markedIndices || [],
          },
        },
      }));
    }
  };
  useEffect(() => {
    const finalRanking = roomData?.gameState?.finalRanking;
    if (finalRanking && finalRanking.length > 0) {
      setRanking(finalRanking);
    } else {
      setRanking([]);
    }
  }, [roomData?.gameState?.finalRanking]);


  // Iniciar juego (solo host)
  const startGame = async () => {
    if (!isHost) return;

    if (!selectedMode) {
      setShowModeModal(true);
      return;
    }

    try {
      // 1️⃣ Emitir al servidor para que inicie el bucle de cartas
      await gameSocket.emit("startGameLoop", roomId, selectedMode);

      // 2️⃣ Limpiar markedIndices para el nuevo juego
      const updatedPlayers = { ...roomData.players };
      Object.keys(updatedPlayers).forEach(pName => {
        updatedPlayers[pName].markedIndices = [];
      });

      // 3️⃣ Optimistic update (solo el modo y el estado activo)
      setRoomData((prev: any) => ({
        ...(prev || {}),
        players: updatedPlayers,
        gameState: {
          ...(prev?.gameState || {}),
          isGameActive: true,
          winner: null,
          gameMode: selectedMode,
          timestamp: Date.now(),
          finalRanking: null,
        }
      }));

      setRanking([]);
      setFirstCard(null);
    } catch (error) {
      console.error("Error al iniciar juego:", error);
      alert("Error al iniciar el juego. Intenta de nuevo.");
    }
  };


  // Reiniciar juego (solo host)
  const resetGame = async () => {
    if (!isHost) return;

    const updatedPlayers = { ...roomData.players };
    Object.keys(updatedPlayers).forEach(pName => {
      updatedPlayers[pName].board = generateBoard();
      updatedPlayers[pName].markedIndices = [];
    });

    const newState = {
      host: playerName,
      isGameActive: false,
      winner: null,
      calledCardIds: [],
      gameMode: null,
      timestamp: Date.now(),
      finalRanking: null,
    };

    // Optimistic update
    setRoomData((prev: any) => ({
      ...(prev || {}),
      players: updatedPlayers,
      gameState: newState
    }));

    await gameSocket.emit("updateRoom", roomId, {
      players: updatedPlayers,
      gameState: {
        host: playerName,
        isGameActive: false,
        winner: null,
        calledCardIds: [],
        gameMode: null,
        timestamp: Date.now(),
        finalRanking: null,
      }
    });

    setRanking([]);
    setFirstCard(null);
    setSelectedMode(""); // resetea el Select
  };


  // Cantada automática de cartas (solo host)
  /* cambiar al servidor la logica de paso de carta
  useEffect(() => {
    if (
      isHost &&
      gameState?.isGameActive &&
      !gameState?.winner &&
      Array.isArray(gameState.deck) &&
      Array.isArray(gameState.calledCardIds)
    ) {
      if (gameState.calledCardIds.length >= gameState.deck.length) return;

      if (intervalRef.current) clearInterval(intervalRef.current);

      intervalRef.current = setInterval(async () => {
        // Obtén el estado más reciente
        if (
          !gameState.isGameActive ||
          gameState.winner ||
          gameState.calledCardIds.length >= gameState.deck.length
        ) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return;
        }
        const nextIndex = gameState.calledCardIds.length;
        const newCalledCardIds = [
          ...gameState.calledCardIds,
          gameState.deck[nextIndex].id,
        ];
        await gameSocket.emit("updateRoom", roomId, {
          gameState: {
            ...gameState,
            calledCardIds: newCalledCardIds,
          },
        });
      }, 100); // <-- 3.5 segundos entre cartas CAMBIAR
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [
    isHost,
    gameState?.isGameActive,
    gameState?.winner,
    gameState?.deck,
    gameState?.calledCardIds,
    roomId,
  ]);
  */

  if (!player || !gameState || !player.board) {
    return (
      <div className="flex flex-col gap-4 items-center justify-center h-64">
        <p className="text-xl text-muted-foreground">Cargando sala, un momento...</p>
      </div>
    );
  }

  const calledCards = Array.isArray(gameState.calledCardIds)
    ? gameState.calledCardIds.map(id => CARDS.find(c => c.id === id)).filter(Boolean) as CardType[]
    : [];
  const currentCard = calledCards.length > 0 ? calledCards[calledCards.length - 1] : null;
  const uniqueHistory = calledCards.filter(
    (card, index, self) => self.findIndex(c => c.id === card.id) === index
  );
  /*
  // Efecto para cantar la carta con voz tipo jaws
  useEffect(() => {
    if (cantaditoActivo && currentCard?.description) {
      cantarCarta(currentCard.description, currentCard.name);
    }
  }, [currentCard, cantaditoActivo]);
  */

  useEffect(() => {
    if (cantaditoActivo && currentCard?.description) {
      cantarCartaConAudio(currentCard);
    }
  }, [currentCard, cantaditoActivo]);


  // Reiniciar solo la tabla del jugador actual
  const resetPlayerBoard = async () => {
    if (!player) return;
    const updatedPlayers = {
      ...roomData.players,
      [playerName]: {
        ...player,
        board: generateBoard(),
        markedIndices: [],
      }
    };

    // Optimistic update: reemplazar tabla local antes de confirmar servidor
    setRoomData((prev: any) => ({
      ...(prev || {}),
      players: updatedPlayers
    }));

    await gameSocket.emit("updateRoom", roomId, {
      players: updatedPlayers,
    });
    setRanking([]);
  };

  // Manejo de inactividad
  useEffect(() => {
    const resetActivity = () => setLastActivity(Date.now());

    window.addEventListener("click", resetActivity);
    window.addEventListener("keydown", resetActivity);
    window.addEventListener("mousemove", resetActivity);

    return () => {
      window.removeEventListener("click", resetActivity);
      window.removeEventListener("keydown", resetActivity);
      window.removeEventListener("mousemove", resetActivity);
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (Date.now() - lastActivity > 90_000) { // tiempo de inactividad (1m 30s)
        setShowIdleModal(true);
      }
    }, 15_000); // si no hay actividad, sale 15s después

    return () => clearInterval(interval);
  }, [lastActivity]);


  // Cuando el juego termina, resetea la carta inicial en todos los jugadores
  useEffect(() => {
    // Cuando el juego termina, resetea la carta inicial en todos los jugadores
    if (!gameState.isGameActive) {
      setFirstCard(null);
    }
  }, [gameState.isGameActive]);

  // Función que determina si una carta es clickeable según el modo y la primera carta seleccionada
  const isAllowed = (card: { row: number; col: number }) => {
    const idx = card.row * 4 + card.col;
    const mode = effectiveMode || "full";

    // Diagonales: antes de seleccionar primera carta sólo mostrar indices válidos
    if (mode === "diagonal" && !firstCard) {
      const diagonalIndices = [0, 5, 10, 15, 3, 6, 9, 12];
      return diagonalIndices.includes(idx);
    }

    // Esquinas: sólo las esquinas en todo momento
    if (mode === "corners") {
      const cornerIndices = [0, 3, 12, 15];
      return cornerIndices.includes(idx);
    }

    // Cuadrado fijo central (si se usa): sólo indices centrales
    if (mode === "square" && !firstCard) {
      const squareIndices = [5, 6, 9, 10];
      return squareIndices.includes(idx);
    }

    // Si no hay firstCard y el modo permite que la primera carta la elija el jugador,
    // permitimos el primer click en cualquier carta (será fijada en handleCardClick).
    if (!firstCard) return true;

    // Si ya hay firstCard, usar la restricción dinámica
    const restriction = getRestriction(mode || "full", firstCard);
    return restriction(card);
  };

  // Mantener selectedMode sincronizado con lo que venga desde el servidor (roomData)
  useEffect(() => {
    const modeFromServer = roomData?.gameState?.gameMode;
    if (modeFromServer && modeFromServer !== selectedMode) {
      setSelectedMode(modeFromServer);
    }
  }, [roomData?.gameState?.gameMode, selectedMode]);

  // Determina el modo efectivo (primero servidor, si no usar selección local)
  const effectiveMode = roomData?.gameState?.gameMode || selectedMode;

  // Escuchar respuesta de claimWin
  useEffect(() => {
    const unsubscribeClaimWin = gameSocket.onClaimWinResult((result) => {
      if (result.success) {
        console.log("✅ Victoria validada por servidor");
      } else {
        console.warn("❌ Victoria rechazada:", result.error || result.alreadyWinner);
      }
    });
    return () => {
      unsubscribeClaimWin();
    };
  }, []);

  return (
    <>
      <ResponsiveScale minWidth={1400} maxScale={1.45}>
        {/* Grid principal: cambia de 1 columna en móvil a 12 columnas en escritorio */}
        {/* gap-x mantiene separación horizontal en desktop; gap-y homologa separación vertical en móvil */}
        {/* auto-rows-min hace que cada fila tome solo el alto de su contenido.
            items-start asegura que los hijos comiencen arriba y gap-y sea consistente. */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-x-6 gap-y-4 md:gap-6 auto-rows-min items-start w-full">

          {/* PLAYER LIST - izquierda */}
          <div className="flex justify-center col-span-1 md:col-span-3 gap-3">
            {/* Contenedor responsivo para ajustar tamaño según el viewport */}
            <div className="w-[clamp(160px,18vw,260px)] flex flex-col gap-3">
              {/* Lista de jugadores */}
              <PlayerList
                players={allPlayers}
                currentPlayerName={playerName}
                hostName={gameState.host || ""}
              // roomId removed
              />

              {/* Botones de control del juego */}
              <div className="flex flex-col gap-3">
                {/* Solo lo ve el anfitrión */}
                {isHost && (
                  <>
                    {/* Botón para iniciar juego */}
                    <Button onClick={startGame} disabled={gameState.isGameActive || !!gameState.winner}>
                      <Play className="mr-2" />
                      Iniciar juego
                    </Button>

                    {/* Botón para terminar juego activo */}
                    {gameState.isGameActive && !gameState.winner && (
                      <Button
                        onClick={async () => {
                          if (!isHost) return;

                          // Reinicia solo cartas y firstCard, pero conserva el modo
                          const updatedPlayers = { ...roomData.players };
                          Object.keys(updatedPlayers).forEach(pName => {
                            updatedPlayers[pName].markedIndices = [];
                          });

                          // Optimistic update: limpiar historial y carta actual en UI inmediatamente
                          setRoomData((prev: any) => ({
                            ...(prev || {}),
                            players: updatedPlayers,
                            gameState: {
                              ...(prev?.gameState || {}),
                              isGameActive: false,
                              winner: null,
                              calledCardIds: [], // limpia historial y carta actual
                            },
                          }));

                          // Avisar al servidor (no bloquear la UX si falla)
                          try {
                            gameSocket.emit("stopGameLoop", roomId);
                            await gameSocket.emit("updateRoom", roomId, {
                              players: updatedPlayers,
                              gameState: {
                                ...gameState,
                                isGameActive: false,
                                winner: null,
                                calledCardIds: [],
                              },
                            });
                          } catch (e) {
                            console.warn("Error notifying server when ending game:", e);
                          }

                          setFirstCard(null); // reinicia carta inicial
                          setRanking([]); // limpiar ranking para que no aparezca en UI
                        }}
                        variant="destructive"
                      >
                        Terminar juego
                      </Button>
                    )}

                    {/* Cambio de tipo de juego */}
                    <div className="w-full">
                      <Select
                        value={selectedMode}
                        onValueChange={async (value) => {
                          setSelectedMode(value);
                          setFirstCard(null); // resetea la carta inicial al cambiar modo
                          await gameSocket.emit("updateRoom", roomId, {
                            gameState: {
                              ...roomData.gameState,
                              gameMode: value,
                            },
                          });
                        }}
                      >
                        <SelectTrigger className="w-full" disabled={gameState.isGameActive}>
                          <SelectValue placeholder="Seleccionar modo de juego" />
                        </SelectTrigger>
                        <SelectContent>
                          {Object.entries(GAME_MODE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                )}

                {/* Botón para reiniciar la tabla del jugador actual */}
                <Button onClick={resetPlayerBoard} variant="outline" disabled={gameState.isGameActive}>
                  <RotateCw className="mr-2" />
                  Nueva tabla
                </Button>

                {/* Mensaje para jugadores que no son anfitrión */}
                {!isHost && gameState.host && !gameState.isGameActive && !gameState.winner && (
                  <p className="text-center text-muted-foreground bg-muted py-2">
                    <span className="font-bold">{gameState.host || "Anfitrión"}</span> es el anfitrión. Esperando...
                  </p>
                )}

                {/* Mensaje de modo de juego */}
                {!isHost && gameState.gameMode && (
                  <div className="bg-primary/20 text-center py-2">
                    <p className="text-sm">
                      Modo:{" "}
                      <span className="font-semibold">
                        {GAME_MODE_LABELS[gameState.gameMode] || gameState.gameMode}
                      </span>
                    </p>
                  </div>
                )}

                {/* Botón Cantadito */}
                <Button
                  variant={cantaditoActivo ? "default" : "outline"}
                  onClick={() => setCantaditoActivo((prev) => !prev)}
                >
                  {cantaditoActivo ? (
                    <>
                      <VolumeOff className="mr-2" />
                      Cantadito
                    </>
                  ) : (
                    <>
                      <Volume2 className="mr-2" />
                      Cantadito
                    </>
                  )}
                </Button>
              </div>

            </div>
          </div>

          {/* COLUMNA CENTRAL: historial + carta actual */}
          {/* Historial + carta actual: usar gap-4 en móvil para igualar gap-y del grid */}
          <div className="flex flex-col items-center gap-4 col-span-1 md:col-span-5">
            {/* Contenedor con ancho responsivo compartido */}
            <div className="w-[clamp(180px,17vw,250px)] md:w-[clamp(140px,18vw,250px)]">
              {/* HISTORIAL (solo 3 cartas recientes) */}
              <DealerDisplay
                currentCard={null}
                history={uniqueHistory.slice(-3)} // 3 últimas cartas
                showCurrentCard={false}
                showHistory={true}
              />
            </div>
            <div className="w-[clamp(160px,17vw,250px)] md:w-[clamp(140px,18vw,250px)] aspect-[3/4]">
              {/* CARTA ACTUAL */}
              <DealerDisplay
                currentCard={currentCard}
                showCurrentCard={true}
                showHistory={false}
              />
            </div>
          </div>


          {/* TABLERO + BOTÓN - derecha (reemplaza la sección anterior del tablero y el botón flotante) */}
          {/* -mt-3 en móvil reduce el espacio vertical entre la carta actual (col central) y el tablero */}
          {/* Tablero: quitar margen negativo, dejar el grid gap-y controlar el espaciado */}
          {/* asegurar que no haya margen superior que rompa el gap en móvil */}
          <div className="flex justify-center col-span-1 md:col-span-4 gap-3 mt-0 md:mt-0">
             <div className="relative">
               {/* Contenedor responsivo del tablero.
                   En pantallas md+ añadimos padding-bottom para reservar espacio
                   y que el botón pueda situarse "debajo" del tablero dentro del recuadro. */}
               <div className="md:pb-12">
                 <div className="mx-auto w-[clamp(300px,92vw,560px)] md:w-[clamp(220px,28vw,400px)] aspect-[265/380]">
                   <GameBoard
                     board={player.board}
                     onCardClick={handleCardClick}
                     markedIndices={player.markedIndices}
                     calledCardIds={Array.isArray(gameState.calledCardIds) ? gameState.calledCardIds : []}
                     isAllowed={isAllowed}
                   />
                 </div>
               </div>

               {/* Botón dentro del recuadro: en md+ se posiciona absolute bottom-right (dentro del padding que añadimos) */}
               <div className="hidden md:flex absolute right-0 bottom-[-2px] z-20">
                 <Button
                   size="icon"
                   className="bg-[#D4165C] text-white hover:bg-[#AA124A] border-2 border-primary"
                   onClick={() => setShowExitModal(true)}
                   aria-label="Salir de la sala"
                 >
                   <LogOut />
                 </Button>
               </div>

               {/* Botón debajo del tablero en móvil (1 columna) */}
               <div className="mt-3 md:hidden flex justify-center">
                 <Button
                   size="sm"
                   className="bg-[#D4165C] text-white hover:bg-[#AA124A] border-2 border-primary"
                   onClick={() => setShowExitModal(true)}
                 >
                   <LogOut />

                 </Button>
               </div>
             </div>
           </div>

          {/* Deja modales y botones flotantes fuera del wrapper */}
          {/* Modal que indica que se debe seleccionar modo */}
          <ModeRequiredModal open={showModeModal} onClose={() => setShowModeModal(false)} />

          {/* Modal que muestra el ganador */}
          <WinnerModal
            // Abrir modal si hay un winner O si el servidor calculó finalRanking (mazo agotado)
            open={!!gameState?.winner || (Array.isArray(gameState?.finalRanking) && gameState.finalRanking.length > 0)}
            ranking={Array.isArray(gameState?.finalRanking) && gameState.finalRanking.length > 0 ? gameState.finalRanking : ranking}
            gameMode={gameState.gameMode}
            currentPlayer={playerName}
            winnerName={gameState.winner}
            onRestart={isHost ? resetGame : undefined}
          />


          {/* Modal de inactividad */}
          <IdleModal
            open={showIdleModal}
            onStay={() => {
              setShowIdleModal(false);
              setLastActivity(Date.now());
            }}
            onExit={() => {
              window.location.href = "/"; // vuelve al login
            }}
          />

          {/* Modal de confirmación de salida */}
          <ConfirmExitModal
            open={showExitModal}
            onClose={() => setShowExitModal(false)}
            onConfirm={() => {
              // confirmar salida: navegar a home (puedes cambiar por logout real si hay lógica)
              window.location.href = "/";
            }}
          />

        </div>
      </ResponsiveScale>

    </>
  );
}
