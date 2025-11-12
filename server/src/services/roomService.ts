import { dbGetAsync, dbRunAsync, dbAllAsync } from '../config/database';
import { Room, Player, GameState } from '../types/game';
import {createDeck} from '../services/loteria';
interface DBRoom {
  data: string;
}
const cardIntervals: Map<string, any> = new Map();
const CALL_INTERVAL = 3500; // 3.5 segundos entre cartas
const MAX_PLAYERS = 100; // límite de jugadores por sala

export class RoomService {
  static async getRoom(roomId: string): Promise<Room | null> {
    const result = (await dbGetAsync<DBRoom>('SELECT data FROM rooms WHERE id = ?', [roomId])) as DBRoom | undefined;
    return result ? (JSON.parse(result.data) as Room) : null;
  }

  static async createOrUpdateRoom(roomId: string, roomData: Room): Promise<void> {
    await dbRunAsync(
      'INSERT OR REPLACE INTO rooms (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      [roomId, JSON.stringify(roomData)]
    );
  }

  // limpia todas las listas de players en la base de datos (mantiene gameState pero vacía host)
  static async clearAllPlayers(): Promise<void> {
    const rows = await dbAllAsync<{ id: string; data: string }>('SELECT id, data FROM rooms', []);
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data) as Room;
        if (parsed) {
          parsed.players = {}; // vaciar players históricos
          if (parsed.gameState) parsed.gameState.host = ''; // limpiar host
          await dbRunAsync('UPDATE rooms SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(parsed), row.id]);
        }
      } catch (e) {
        // ignora filas malformadas
        console.error('clearAllPlayers: error parsing row', row.id, e);
      }
    }
  }

  // lógica para manejar el intervalo de llamada de cartas por sala
  static async initializeGame(roomId: string, gameMode: string): Promise<Room> {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error(`Room ${roomId} not found during initialization.`);
    }

    // El mazo completo barajado (guardamos solo los IDs para que sea ligero)
    const newDeck = createDeck().map(c => c.id);

    // Limpiar marcas de jugadores
    Object.keys(room.players).forEach(pName => {
      room.players[pName].markedIndices = [];
    });

    // Asegurarse de que el estado sea un GameState completo
    const newGameState: GameState = {
      ...room.gameState,
      deck: newDeck,
      calledCardIds: [], // Empieza vacío
      isGameActive: true,
      winner: null,
      gameMode: gameMode,
      timestamp: Date.now(),
      finalRanking: null,
    };

    room.gameState = newGameState;

    await this.createOrUpdateRoom(roomId, room);
    return room;
  }
  // 2. Lógica atómica para llamar a la siguiente carta
  static async callNextCard(roomId: string, io: any): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room || !room.gameState.isGameActive || room.gameState.winner) {
      // Detiene el intervalo si el juego ya no es válido
      this.stopCallingCards(roomId);
      return;
    }

    const gameState = room.gameState;

    if (gameState.deck.length === 0) {
      console.log(`Sala ${roomId}: Mazo vacío. Finalizando llamadas automáticas.`);
      this.stopCallingCards(roomId);
      return;
    }

    // 🛑 Lógica atómica de extracción de carta en el servidor
    const nextCardId = gameState.deck.pop();

    if (nextCardId !== undefined) {
      gameState.calledCardIds.push(nextCardId);
      gameState.timestamp = Date.now();

      // Guardar el estado actualizado
      await this.createOrUpdateRoom(roomId, room);

      // Emitir el nuevo estado del juego a todos (usa el evento que el cliente ya escucha)
      io.to(roomId).emit("gameUpdated", gameState);
      // Si el cliente necesita actualizar players (ej. si hubo ganador y se limpiaron marcas),
      // se debe emitir un updateRoom o los updates individuales de player.
    }
  }

  // 3. Iniciar el bucle de llamadas automáticas
  static async startCallingCards(roomId: string, io: any): Promise<void> {
    // Asegura que no haya otro temporizador corriendo para esta sala
    this.stopCallingCards(roomId);

    // Programa las llamadas sucesivas
    const interval = setInterval(() => {
      this.callNextCard(roomId, io);
    }, CALL_INTERVAL);

    cardIntervals.set(roomId, interval);
    console.log(`⏱️ Bucle de llamadas iniciado para sala ${roomId} cada ${CALL_INTERVAL / 1000}s.`);
  }

  // 4. Detener el bucle de llamadas
  static async stopCallingCards(roomId: string): Promise<void> {
    const interval = cardIntervals.get(roomId);
    if (interval) {
      clearInterval(interval);
      cardIntervals.delete(roomId);
      console.log(`✅ Intervalo detenido para sala ${roomId}`);
    }

    // Limpiar el estado del juego en la BD
    const room = await this.getRoom(roomId);
    if (room) {
      room.gameState = {
        ...room.gameState,
        isGameActive: false,
        calledCardIds: [],
        deck: [],
      };
      await this.createOrUpdateRoom(roomId, room);
    }
  }

  // añade jugador con retorno claro; si host está vacío se asigna al primer jugador activo
  static async addPlayer(
    roomId: string,
    playerName: string,
    playerData: Player
  ): Promise<{
    added: boolean;
    reason?: 'name_exists' | 'name_in_use' | 'full';
  }> {
    const nameKey = playerName.trim();
    const room = await this.getRoom(roomId);

    // Si la sala no existe, crear nueva
    if (!room) {
      const newRoom: Room = {
        players: {
          [nameKey]: { ...playerData, isOnline: true }
        },
        gameState: {
          host: nameKey,
          isGameActive: false,
          winner: null,
          gameMode: "",
          deck: [],
          calledCardIds: [],
          timestamp: Date.now(),
          finalRanking: null,
        }
      };
      await this.createOrUpdateRoom(roomId, newRoom);
      return { added: true };
    }

    // Verificar jugador existente
    const existingPlayer = Object.entries(room.players || {}).find(
      ([key]) => key.toLowerCase() === nameKey.toLowerCase()
    );

    if (existingPlayer) {
      return { added: false, reason: 'name_in_use' };
    }

    // Verificar límite de jugadores
    if (Object.keys(room.players || {}).length >= MAX_PLAYERS) {
      return { added: false, reason: 'full' };
    }

    // Añadir nuevo jugador
    room.players[nameKey] = { ...playerData, isOnline: true };

    // Asignar host si no hay
    if (!room.gameState.host) {
      room.gameState.host = nameKey;
    }

    await this.createOrUpdateRoom(roomId, room);
    return { added: true };
  }


  static async removePlayer(roomId: string, playerName: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) return;
    const key = Object.keys(room.players || {}).find(k => k.trim().toLowerCase() === playerName.trim().toLowerCase());
    if (!key) return;
    delete room.players[key];

    // si el host ya no existe, reasignar host al primer jugador disponible o dejar vacío
    if (room.gameState && room.gameState.host && !(room.players && room.players[room.gameState.host])) {
      const remaining = Object.keys(room.players || {});
      room.gameState.host = remaining.length > 0 ? remaining[0] : '';
    }

    await this.createOrUpdateRoom(roomId, room);
  }

  static async deleteRoom(roomId: string): Promise<void> {
    try {
      await dbRunAsync('DELETE FROM rooms WHERE id = ?', [roomId]);
      console.log(`Sala ${roomId} eliminada correctamente.`);
    } catch (error) {
      console.error(`Error al eliminar la sala ${roomId}:`, error);
      throw error;
    }
  }

}