import { Injectable, Logger } from '@nestjs/common';
import { TechnicianRealtimeService } from '../../signaling/realtime/technician-realtime.service';

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
 * Aviso a todos los tecnicos y admins conectados de que cambio la presencia
 * efectiva (ONLINE/OFFLINE) de un dispositivo.
 *
 * Es solo un disparador de invalidacion: la web vuelve a leer `GET /devices` y
 * `GET /support-requests`, que siguen siendo la fuente de verdad.
 */
export const DEVICE_PRESENCE_UPDATED_EVENT = 'device:presence-updated';

/**
 * Payload de `device:presence-updated`.
 *
 * Solo el id interno del dispositivo: ni el estado nuevo, ni sockets, ni
 * credenciales. Quien lo recibe relee el estado por REST.
 */
export interface DevicePresenceUpdatedPayload {
  deviceId: string;
}

/**
 * Presencia ONLINE/OFFLINE de los dispositivos.
 *
 * `ONLINE` significa que el dispositivo tiene al menos un socket autenticado
 * vivo. No es estado persistente y no debe confundirse con `Device.isActive`,
 * que es el estado administrativo y si vive en PostgreSQL.
 *
 * Es el UNICO dueno del registro, asi que tambien es el unico que sabe cuando
 * la presencia efectiva cambia de verdad (OFFLINE -> ONLINE al registrar el
 * primer socket, ONLINE -> OFFLINE al quitar el ultimo). Por eso el aviso
 * `device:presence-updated` se emite desde aqui y no desde cada flujo que
 * conecta, desconecta, desactiva o re-enrola: ninguno de ellos tiene que
 * acordarse de avisar y no puede haber avisos duplicados ni falsos.
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

  constructor(
    private readonly technicianRealtimeService: TechnicianRealtimeService,
  ) {}

  /**
   * Registra un socket ya autenticado.
   *
   * Un mismo dispositivo puede tener varios a la vez: durante una reconexion el
   * socket nuevo puede llegar antes de que el viejo se detecte como muerto.
   *
   * Devuelve `true` si este socket es el primero y el dispositivo pasa a
   * ONLINE; solo en ese caso se avisa a los tecnicos.
   */
  register(deviceId: string, socket: PresenceSocket): boolean {
    const sockets = this.connections.get(deviceId);

    if (sockets) {
      sockets.set(socket.id, socket);
      return false;
    }

    this.connections.set(deviceId, new Map([[socket.id, socket]]));

    // El registro ya esta actualizado: `isOnline` (y por tanto REST) devuelve
    // ONLINE antes de que salga el aviso.
    this.notifyPresenceUpdated(deviceId);

    return true;
  }

  /**
   * Da de baja un socket.
   * Devuelve `true` si era el ultimo y el dispositivo pasa a OFFLINE.
   *
   * Un socket que ya no esta registrado (baja repetida, o el `disconnect` tardio
   * de un socket viejo despues de `disconnectDevice` o de que llegara uno nuevo)
   * no cambia nada y no avisa.
   */
  unregister(deviceId: string, socketId: string): boolean {
    const sockets = this.connections.get(deviceId);

    if (!sockets) return false;

    sockets.delete(socketId);

    if (sockets.size > 0) return false;

    this.connections.delete(deviceId);

    this.notifyPresenceUpdated(deviceId);

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
   * Devuelve cuantos sockets se cerraron. Solo avisa a los tecnicos si habia
   * alguno, es decir, si el dispositivo estaba ONLINE de verdad.
   */
  disconnectDevice(deviceId: string): number {
    const sockets = this.connections.get(deviceId);

    if (!sockets) return 0;

    // Se saca del registro antes de cerrar: cerrar dispara el `handleDisconnect`
    // del gateway, que asi ya no encuentra nada que dar de baja y no repite el
    // aviso.
    this.connections.delete(deviceId);

    for (const socket of sockets.values()) socket.disconnect(true);

    this.logger.log(
      `Device ${deviceId} is no longer authorized: closed ${sockets.size} socket(s)`,
    );

    this.notifyPresenceUpdated(deviceId);

    return sockets.size;
  }

  /**
   * Avisa a todos los tecnicos y admins conectados de que la presencia del
   * dispositivo cambio.
   *
   * Solo se llama tras una transicion efectiva y con el registro ya
   * actualizado. Igual que los avisos de solicitudes, un fallo del transporte
   * se registra y no se propaga: la presencia no se deshace y quien llamo
   * (el gateway, una desactivacion, un re-enrolamiento) sigue su curso.
   */
  private notifyPresenceUpdated(deviceId: string): void {
    const payload: DevicePresenceUpdatedPayload = { deviceId };

    try {
      this.technicianRealtimeService.emitToAllTechnicians(
        DEVICE_PRESENCE_UPDATED_EVENT,
        payload,
      );
    } catch (error) {
      this.logger.error(
        `Device ${deviceId} is ${this.isOnline(deviceId) ? 'ONLINE' : 'OFFLINE'}, but ${DEVICE_PRESENCE_UPDATED_EVENT} could not be delivered to technicians`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
