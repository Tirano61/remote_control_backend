import { Injectable, Logger } from '@nestjs/common';

/** Room privada del dispositivo. La asigna el servidor, nunca el cliente. */
export const deviceRoom = (deviceId: string): string => `device:${deviceId}`;

/**
 * Lo minimo que hace falta para hacer llegar un evento a un dispositivo.
 *
 * Es a proposito una interfaz y no el `Namespace` de Socket.IO: quien emite
 * (por ejemplo `SupportRequestsService`) no necesita conocer la libreria de
 * transporte ni el gateway.
 */
export interface DeviceEventTarget {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

/**
 * Salida de eventos hacia los dispositivos conectados.
 *
 * Existe para que los dominios (solicitudes de asistencia, y mas adelante
 * sesiones remotas o signaling) puedan avisar a una tablet sin depender de
 * `DevicesGateway`: el gateway registra aqui su namespace al inicializarse y
 * los demas modulos solo ven `emitToDevice`.
 *
 * Va en un modulo propio, sin dependencias, para que quien emite no tenga que
 * importar `DevicesModule` y no aparezcan dependencias circulares.
 *
 * Se emite a la room del dispositivo en lugar de a los sockets registrados en
 * presencia: la room la resuelve el adaptador de Socket.IO, asi que el dia que
 * haya varias instancias con un adaptador compartido el evento seguira
 * llegando aunque la tablet este conectada a otra instancia.
 */
@Injectable()
export class DeviceRealtimeService {
  private readonly logger = new Logger(DeviceRealtimeService.name);

  /** Lo deja el gateway en su `afterInit`. Sin el no hay a donde emitir. */
  private target: DeviceEventTarget | null = null;

  /** Registra el namespace de dispositivos ya inicializado. */
  bind(target: DeviceEventTarget): void {
    this.target = target;
  }

  /**
   * Envia un evento a todas las conexiones autenticadas del dispositivo.
   *
   * Devuelve `false` cuando no hay transporte disponible todavia. Que devuelva
   * `true` solo significa que el evento se entrego al transporte: si la tablet
   * esta OFFLINE el evento se pierde, y ese es el comportamiento buscado.
   * El estado de la solicitud vive en PostgreSQL, asi que el dispositivo puede
   * recuperarlo al reconectarse; Socket.IO solo adelanta el aviso.
   */
  emitToDevice(deviceId: string, event: string, payload: unknown): boolean {
    if (!this.target) {
      this.logger.warn(
        `No realtime transport available: event ${event} for device ${deviceId} was not delivered`,
      );
      return false;
    }

    this.target.to(deviceRoom(deviceId)).emit(event, payload);

    return true;
  }
}
