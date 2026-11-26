import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import type { SocketIoHeartbeatConfig } from './socket-io-heartbeat.config';

/**
 * Adaptador de Socket.IO con CORS y heartbeat configurables.
 *
 * En Socket.IO el CORS y el heartbeat son del SERVIDOR (de su Engine.IO), no de
 * cada namespace: `/devices` y `/technicians` comparten una unica instancia, asi
 * que las opciones que se pusieran en el decorador `@WebSocketGateway` de un
 * gateway solo se aplicarian si resultara ser el primero en inicializarse. Por
 * eso se configuran aqui, que es el unico punto por el que pasa la creacion del
 * servidor, y se aplican DESPUES de las opciones recibidas para que ningun
 * decorador las pueda sustituir.
 *
 * Los origenes salen de variables de entorno (ver `cors.config.ts`) y nunca se
 * usa `origin: '*'`. Las tablets no son un navegador y no envian cabecera
 * `Origin`, de modo que el CORS no cambia nada para `/devices`.
 *
 * El heartbeat llega ya validado (ver `socket-io-heartbeat.config.ts`) y los
 * clientes lo reciben en el handshake de Engine.IO.
 */
export class SocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly corsOrigins: string[],
    private readonly heartbeat: SocketIoHeartbeatConfig,
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
      pingInterval: this.heartbeat.pingIntervalMs,
      pingTimeout: this.heartbeat.pingTimeoutMs,
    });
  }
}
