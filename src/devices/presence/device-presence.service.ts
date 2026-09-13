import { Injectable, Logger } from '@nestjs/common';

/**
 * Lo minimo que la presencia necesita de un socket: identificarlo y poder
 * cerrarlo.
 *
 * Es a proposito independiente de Socket.IO: asi el servicio no depende del
 * gateway y los servicios que invalidan una autorizacion pueden pedirle que
 * cierre conexiones sin arrastrar la capa de transporte.
 */
export interface PresenceSocket {
  readonly id: string;
  disconnect(close?: boolean): void;
}

/**
 * Presencia ONLINE/OFFLINE de los dispositivos.
 *
 * `ONLINE` significa que el dispositivo tiene al menos un socket autenticado
 * vivo. No es estado persistente y no debe confundirse con `Device.isActive`,
 * que es el estado administrativo y si vive en PostgreSQL.
 *
 * LIMITACION CONOCIDA: el registro es en memoria, por lo que solo es valido
 * para UNA instancia de NestJS. Con varias instancias, un dispositivo conectado
 * a otra instancia se veria OFFLINE aqui; entonces hara falta un adaptador
 * compartido (Socket.IO Redis Adapter), que no forma parte de este paso.
 *
 * Tras reiniciar el proceso el registro queda vacio: todos los dispositivos son
 * OFFLINE hasta que vuelvan a conectarse.
 */
@Injectable()
export class DevicePresenceService {
  private readonly logger = new Logger(DevicePresenceService.name);

  /** deviceId -> sockets autenticados de ese dispositivo (socketId -> socket). */
  private readonly connections = new Map<string, Map<string, PresenceSocket>>();

  /**
   * Registra un socket ya autenticado.
   *
   * Un mismo dispositivo puede tener varios a la vez: durante una reconexion el
   * socket nuevo puede llegar antes de que el viejo se detecte como muerto.
   */
  register(deviceId: string, socket: PresenceSocket): void {
    const sockets = this.connections.get(deviceId);

    if (sockets) {
      sockets.set(socket.id, socket);
      return;
    }

    this.connections.set(deviceId, new Map([[socket.id, socket]]));
  }

  /**
   * Da de baja un socket.
   * Devuelve `true` si era el ultimo y el dispositivo pasa a OFFLINE.
   */
  unregister(deviceId: string, socketId: string): boolean {
    const sockets = this.connections.get(deviceId);

    if (!sockets) return false;

    sockets.delete(socketId);

    if (sockets.size > 0) return false;

    this.connections.delete(deviceId);

    return true;
  }

  /** ONLINE = queda al menos un socket autenticado en esta instancia. */
  isOnline(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }

  /** Sockets autenticados vivos del dispositivo. */
  connectionCount(deviceId: string): number {
    return this.connections.get(deviceId)?.size ?? 0;
  }

  /**
   * Cierra todas las conexiones del dispositivo, que queda OFFLINE.
   *
   * Lo usan los flujos que retiran la autorizacion (desactivacion
   * administrativa, re-enrolamiento): un socket ya abierto no revalida nada por
   * si mismo, asi que hay que cerrarlo en ese momento y no esperar a que venza
   * el Device JWT.
   *
   * Devuelve cuantos sockets se cerraron.
   */
  disconnectDevice(deviceId: string): number {
    const sockets = this.connections.get(deviceId);

    if (!sockets) return 0;

    // Se saca del registro antes de cerrar: cerrar dispara el `handleDisconnect`
    // del gateway, que asi ya no encuentra nada que dar de baja.
    this.connections.delete(deviceId);

    for (const socket of sockets.values()) socket.disconnect(true);

    this.logger.log(
      `Device ${deviceId} is no longer authorized: closed ${sockets.size} socket(s)`,
    );

    return sockets.size;
  }
}
