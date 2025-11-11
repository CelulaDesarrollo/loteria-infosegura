export interface Player {
  name: string;
  isOnline: boolean;
  board: any[];
  markedIndices: number[];
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