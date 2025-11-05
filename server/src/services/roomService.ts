import { dbGetAsync, dbRunAsync } from '../config/database';
import { Room, Player } from '../types/game';

interface DBRoom {
  data: string;
}

export class RoomService {
  static async getRoom(roomId: string): Promise<Room | null> {
    try {
      const result = (await dbGetAsync<DBRoom>('SELECT data FROM rooms WHERE id = ?', [roomId])) as DBRoom | undefined;
      return result ? JSON.parse(result.data) : null;
    } catch (error) {
      console.error('Error getting room:', error);
      return null;
    }
  }

  static async createOrUpdateRoom(roomId: string, roomData: Room): Promise<void> {
    try {
      await dbRunAsync(
        'INSERT OR REPLACE INTO rooms (id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [roomId, JSON.stringify(roomData)]
      );
    } catch (error) {
      console.error('Error updating room:', error);
      throw error;
    }
  }

  static async addPlayer(roomId: string, playerName: string, playerData: Player): Promise<boolean> {
    try {
      const room = await this.getRoom(roomId);
      
      if (!room) {
        const newRoom: Room = {
          players: {
            [playerName]: playerData
          },
          gameState: {
            host: playerName,
            isGameActive: false,
            winner: null,
            deck: [],
            calledCardIds: [],
            timestamp: Date.now()
          }
        };
        await this.createOrUpdateRoom(roomId, newRoom);
        return true;
      }

      room.players[playerName] = playerData;
      await this.createOrUpdateRoom(roomId, room);
      return true;
    } catch (error) {
      console.error('Error adding player:', error);
      return false;
    }
  }

  static async removePlayer(roomId: string, playerName: string): Promise<void> {
    try {
      const room = await this.getRoom(roomId);
      if (room && room.players[playerName]) {
        delete room.players[playerName];
        await this.createOrUpdateRoom(roomId, room);
      }
    } catch (error) {
      console.error('Error removing player:', error);
    }
  }
}