import Fastify from 'fastify';
import fastifySocketIO from 'fastify-socket.io';
import fastifyCors from '@fastify/cors';
import { Server } from 'socket.io';
import { RoomService } from './services/roomService';
import { Player } from './types/game';

const fastify = Fastify({ logger: true });

// Configurar CORS
fastify.register(fastifyCors, {
  origin: ['http://localhost:3000'],
  credentials: true
});

// Configurar Socket.IO
fastify.register(fastifySocketIO);

// Declarar tipo para io (opcional, evita cast en varios lugares)
declare module 'fastify' {
  interface FastifyInstance {
    io: Server
  }
}

// Ruta de salud
fastify.get('/health', async () => {
  return { status: 'ok' };
});

// Ruta raíz simple
fastify.get('/', async () => ({ status: 'ok', message: 'Loteria server' }));

// Configurar WebSockets
fastify.ready(err => {
  if (err) throw err;

  const io = (fastify as any).io as Server;

  io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    socket.on('joinRoom', async ({ roomId, playerName, playerData }: {
      roomId: string;
      playerName: string;
      playerData: Player;
    }) => {
      try {
        const success = await RoomService.addPlayer(roomId, playerName, playerData);
        
        if (success) {
          socket.join(roomId);
          const room = await RoomService.getRoom(roomId);
          console.log('Room data after joining:', room); // Log de la sala
          socket.emit('roomJoined', room);
          socket.to(roomId).emit('playerJoined', { playerName, playerData });
        } else {
          console.error('Failed to add player:', playerName); // Log de error
          socket.emit('error', { message: 'No se pudo unir al jugador' });
        }
      } catch (error) {
        console.error('Error al unirse a la sala:', error);
        socket.emit('error', { message: 'Error al unirse a la sala' });
      }
    });

    socket.on('disconnect', () => {
      console.log('Cliente desconectado:', socket.id);
    });
  });
});

// Iniciar servidor
const start = async () => {
  try {
    await fastify.listen({ port: 3001, host: '0.0.0.0' });
    console.log('Servidor corriendo en http://localhost:3001');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();