import { dbGetAsync, dbRunAsync, dbAllAsync } from '../config/database';
import { Room, Player, GameState } from '../types/game';
import {createDeck} from '../services/loteria';
interface DBRoom {
  data: string;
}
const cardIntervals: Map<string, any> = new Map();
const CALL_INTERVAL = 3500; // 3.5 segundos entre cartas
const MAX_PLAYERS = 100; // ajustar según necesidad

export class RoomService {
  // locks por sala para serializar operaciones asíncronas (evitar carreras locales)
  private static roomLocks: Map<string, Promise<void>> = new Map();

  private static enqueue(roomId: string, fn: () => Promise<void>) {
    const prev = this.roomLocks.get(roomId) || Promise.resolve();
    const next = prev.then(() => fn()).catch((e) => {
      console.error(`roomLocks[${roomId}] error:`, e);
    });
    // guardar la promesa encadenada (no await aquí)
    this.roomLocks.set(roomId, next);
    return next;
  }

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
    // Serializar por sala para evitar condiciones de carrera locales
    await this.enqueue(roomId, async () => {
      const room = await this.getRoom(roomId);
      if (!room) return;

      const deck = room.gameState?.deck || [];
      const called = Array.isArray(room.gameState?.calledCardIds) ? [...room.gameState.calledCardIds] : [];

      const remaining = deck.filter((id: any) => !called.includes(id));
      if (remaining.length === 0) {
        return;
      }

      const nextId = remaining[0];
      called.push(nextId);
      console.log(`🎴 Sala ${roomId} -> llamada carta id=${nextId} (llamadas totales ${called.length}/${deck.length})`);

      room.gameState.calledCardIds = called;
      room.gameState.timestamp = Date.now();
      await this.createOrUpdateRoom(roomId, room);

      io.to(roomId).emit("gameUpdated", room.gameState);
      io.to(roomId).emit("roomUpdated", room);

      if (called.length >= deck.length) {
        const ranking = Object.values(room.players || {}).map((p: any) => ({
          name: p.name,
          seleccionadas: Array.isArray(p.markedIndices) ? p.markedIndices.length : 0,
        })).sort((a, b) => b.seleccionadas - a.seleccionadas);

        room.gameState.isGameActive = false;
        room.gameState.winner = null;
        room.gameState.finalRanking = ranking;
        room.gameState.timestamp = Date.now();

        await this.createOrUpdateRoom(roomId, room);
        io.to(roomId).emit("gameUpdated", room.gameState);
        io.to(roomId).emit("roomUpdated", room);
      }
    });
  }

  // 3. Iniciar el bucle de llamadas automáticas
  static async startCallingCards(roomId: string, io: any): Promise<void> {
    // Si ya hay un intervalo corriendo en este proceso, no crear otro
    if (cardIntervals.has(roomId)) {
      console.log(`⏱️ Ya existe un bucle para ${roomId}, omitiendo nuevo inicio.`);
      return;
    }

    // Llamar una carta inmediatamente y luego programar el intervalo
    try {
      await this.callNextCard(roomId, io);
    } catch (e) {
      console.error(`Error al llamar la carta inicial para ${roomId}`, e);
    }

    const interval = setInterval(() => {
      this.callNextCard(roomId, io).catch((err) => {
        console.error(`Error en callNextCard para ${roomId}:`, err);
      });
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
    // Nota: NO modificamos el estado en BD aquí para evitar borrar el deck inmediatamente
    // (el control de persistencia/limpieza debe ser explícito desde stopGameLoop o updateRoom).
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

  // marcar jugador como activo (actualiza lastSeen/isOnline)
  static async markPlayerActive(roomId: string, playerName: string) {
    const room = await this.getRoom(roomId);
    if (!room) return;
    const key = Object.keys(room.players || {}).find(k => k.trim().toLowerCase() === playerName.trim().toLowerCase());
    if (!key) return;
    const p = room.players[key] || {};
    p.isOnline = true;
    p.lastSeen = Date.now();
    room.players[key] = p;
    await this.createOrUpdateRoom(roomId, room);
  }

  // marcar jugador como offline (no lo borra inmediatamente)
  static async markPlayerOffline(roomId: string, playerName: string) {
    const room = await this.getRoom(roomId);
    if (!room) return;
    const key = Object.keys(room.players || {}).find(k => k.trim().toLowerCase() === playerName.trim().toLowerCase());
    if (!key) return;
    const p = room.players[key] || {};
    p.isOnline = false;
    p.lastSeen = Date.now();
    room.players[key] = p;
    await this.createOrUpdateRoom(roomId, room);
  }

  // limpiar jugadores que llevan inactivos > timeoutMs; reasigna host o borra sala si está vacía
  static async cleanupStalePlayers(timeoutMs = 90_000): Promise<{ roomId: string; room?: Room }[]> {
    const now = Date.now();
    const modified: { roomId: string; room?: Room }[] = [];
    const rows = await dbAllAsync<{ id: string; data: string }>('SELECT id, data FROM rooms', []);
    for (const row of rows) {
      try {
        const room = JSON.parse(row.data) as Room;
        let changed = false;
        const players = room.players || {};
        for (const k of Object.keys(players)) {
          const p = players[k] as any;
          // si no tiene lastSeen y está marcado offline hace cleanup tras timeout
          const lastSeen = typeof p.lastSeen === 'number' ? p.lastSeen : 0;
          if (p.isOnline === false && (now - lastSeen) >= timeoutMs) {
            delete players[k];
            changed = true;
          } else if (p.isOnline !== true && (now - lastSeen) >= timeoutMs) {
            // si no está online y pasó el timeout, quitarlo
            delete players[k];
            changed = true;
          }
        }

        if (changed) {
          // reasignar host si el host ya no existe o no está online
          if (room.gameState) {
            const hostKey = room.gameState.host;
            if (!hostKey || !(players && players[hostKey])) {
              const remaining = Object.keys(players || {});
              room.gameState.host = remaining.length > 0 ? remaining[0] : '';
            }
          }

          // si no quedan players, eliminar sala DB
          if (!players || Object.keys(players).length === 0) {
            await this.deleteRoom(row.id);
            modified.push({ roomId: row.id, room: undefined });
            continue;
          }

          room.players = players;
          await this.createOrUpdateRoom(row.id, room);
          modified.push({ roomId: row.id, room });
        }
      } catch (e) {
        console.error('cleanupStalePlayers: error parsing row', row.id, e);
      }
    }
    return modified;
  }

  // devuelve listado de salas (id + parsed room) — útil para admin
  static async listRooms(): Promise<{ id: string; room?: Room }[]> {
    const rows = await dbAllAsync<{ id: string; data: string }>('SELECT id, data FROM rooms', []);
    return rows.map(r => {
      try {
        return { id: r.id, room: JSON.parse(r.data) as Room };
      } catch {
        return { id: r.id, room: undefined };
      }
    });
  }
}