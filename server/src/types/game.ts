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
  deck: any[];
  calledCardIds: number[];
  timestamp: number;
}

export interface Room {
  players: Record<string, Player>;
  gameState: GameState;
}