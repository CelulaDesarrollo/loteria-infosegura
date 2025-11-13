export interface Player {
  name: string;
  // presencia / cliente
  isOnline?: boolean;
  lastSeen?: number;
  // índices marcados en el tablero
  markedIndices?: number[];
}

export interface GameState {
  host: string;
  isGameActive: boolean;
  winner: string | null;
  gameMode: string;
  deck: any[];
  calledCardIds: number[];
  timestamp: number;

  finalRanking: { name: string; seleccionadas: number }[] | null;
}

export interface Room {
  players: Record<string, Player>;
  gameState: GameState;
}