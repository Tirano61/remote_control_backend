import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Adaptador de Socket.IO con CORS configurable.
 *
 * En Socket.IO el CORS es del SERVIDOR, no de cada namespace: `/devices` y
 * `/technicians` comparten una unica instancia, asi que las opciones que se
 * pusieran en el decorador `@WebSocketGateway` de un gateway solo se aplicarian
 * si resultara ser el primero en inicializarse. Por eso se configura aqui, que
 * es el unico punto por el que pasa la creacion del servidor.
 *
 * Los origenes salen de variables de entorno (ver `cors.config.ts`) y nunca se
 * usa `origin: '*'`.
 *
 * Las tablets no son un navegador y no envian cabecera `Origin`, de modo que
 * esta configuracion no cambia nada para `/devices`.
 */
export class SocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly corsOrigins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, {
      ...options,
      cors: {
        origin: this.corsOrigins,
        credentials: true,
      },
    });
  }
}
