import { dbGetAsync, dbRunAsync, dbAllAsync } from '../config/database';
import { Room, Player } from '../types/game';

interface DBRoom {
  data: string;
}

const MAX_PLAYERS = 100; // ajustar si quieres

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
          deck: [],
          calledCardIds: [],
          timestamp: Date.now()
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