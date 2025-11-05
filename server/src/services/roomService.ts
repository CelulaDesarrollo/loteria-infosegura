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
    reconnected?: boolean;
    reason?: 'name_exists' | 'name_in_use' | 'full'
  }> {
    const nameKey = playerName.trim();
    let room = await this.getRoom(roomId);

    if (!room) {
      const newRoom: Room = {
        players: { [nameKey]: playerData },
        gameState: {
          host: nameKey,
          isGameActive: false,
          winner: null,
          deck: [],
          calledCardIds: [],
          timestamp: Date.now(),
        },
      };
      await this.createOrUpdateRoom(roomId, newRoom);
      return { added: true };
    }

    const existingKeys = Object.keys(room.players || {});
    const existingKey = existingKeys.find(
      (k) => k.trim().toLowerCase() === nameKey.toLowerCase()
    );

    if (existingKey) {
      const existingPlayer = room.players[existingKey];

      // Si el jugador está offline, es una reconexión válida
      if (!existingPlayer.isOnline) {
        room.players[existingKey] = {
          ...existingPlayer,
          ...playerData,
          isOnline: true,
        };
        await this.createOrUpdateRoom(roomId, room);
        return { added: true, reconnected: true };
      }

      // Si ya está online, es un duplicado → rechazamos
      return { added: false, reason: 'name_in_use' };
    }

    if (existingKeys.length >= MAX_PLAYERS) {
      return { added: false, reason: 'full' };
    }

    // añadir jugador; si host está vacío, asignarlo a este jugador
    room.players[nameKey] = playerData;
    if (!room.gameState) {
      room.gameState = {
        host: nameKey,
        isGameActive: false,
        winner: null,
        deck: [],
        calledCardIds: [],
        timestamp: Date.now(),
      };
    } else if (!room.gameState.host || room.gameState.host.trim() === '') {
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
}