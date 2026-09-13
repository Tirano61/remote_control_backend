import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import {
  CorsEnv,
  DEFAULT_DEV_CORS_ORIGINS,
  resolveHttpCorsOrigins,
  resolveSocketIoCorsOrigins,
} from './cors.config';
import { SocketIoAdapter } from './socket-io.adapter';

/**
 * Contrato de las variables de entorno de CORS.
 *
 * Importa porque el namespace `/technicians` lo consumira una Flutter Web que
 * puede vivir en otro origen, y porque el valor por defecto no debe cambiar el
 * comportamiento que ya tenia la API.
 */
describe('CORS configurable', () => {
  const emptyEnv: CorsEnv = {};

  it('usa los origenes de desarrollo cuando no hay variables', () => {
    expect(resolveHttpCorsOrigins(emptyEnv)).toEqual([
      ...DEFAULT_DEV_CORS_ORIGINS,
    ]);
    expect(resolveSocketIoCorsOrigins(emptyEnv)).toEqual([
      ...DEFAULT_DEV_CORS_ORIGINS,
    ]);
  });

  it('lee listas separadas por comas y descarta vacios', () => {
    const env: CorsEnv = {
      CORS_ORIGINS:
        ' https://soporte.example.com , https://admin.example.com ,',
    };

    expect(resolveHttpCorsOrigins(env)).toEqual([
      'https://soporte.example.com',
      'https://admin.example.com',
    ]);
  });

  it('hace que Socket.IO herede los origenes de HTTP si no tiene los suyos', () => {
    const env: CorsEnv = { CORS_ORIGINS: 'https://soporte.example.com' };

    expect(resolveSocketIoCorsOrigins(env)).toEqual([
      'https://soporte.example.com',
    ]);
  });

  it('permite un origen distinto para Socket.IO', () => {
    const env: CorsEnv = {
      CORS_ORIGINS: 'https://api.example.com',
      SOCKET_IO_CORS_ORIGINS: 'https://soporte.example.com',
    };

    expect(resolveSocketIoCorsOrigins(env)).toEqual([
      'https://soporte.example.com',
    ]);
  });

  it('nunca resuelve a un comodin', () => {
    expect(resolveSocketIoCorsOrigins(emptyEnv)).not.toContain('*');
  });

  it('aplica los origenes al servidor de Socket.IO, no a un namespace', () => {
    // El servidor es unico para /devices y /technicians: por eso el CORS se
    // configura en el adaptador y no en el decorador de un gateway.
    const created = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({});

    const adapter = new SocketIoAdapter({} as never, [
      'https://soporte.example.com',
    ]);

    adapter.createIOServer(3000, { path: '/socket.io' } as ServerOptions);

    expect(created).toHaveBeenCalledWith(3000, {
      path: '/socket.io',
      cors: { origin: ['https://soporte.example.com'], credentials: true },
    });

    created.mockRestore();
  });
});
