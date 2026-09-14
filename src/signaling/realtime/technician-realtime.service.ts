import { Injectable, Logger } from '@nestjs/common';

/** Room privada del tecnico. La asigna el servidor, nunca el cliente. */
export const technicianRoom = (technicianId: string): string =>
  `technician:${technicianId}`;

/**
 * Lo minimo que hace falta para hacer llegar un evento a un tecnico.
 *
 * Es a proposito una interfaz y no el `Namespace` de Socket.IO, igual que en
 * `DeviceEventTarget`: quien emite no tiene por que conocer la libreria de
 * transporte ni el gateway.
 */
export interface TechnicianEventTarget {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

/**
 * Salida de eventos de dominio hacia los tecnicos conectados.
 *
 * Es el equivalente de `DeviceRealtimeService` en el namespace `/technicians`:
 * `TechniciansGateway` registra aqui su namespace al inicializarse y los
 * modulos de dominio solo ven `emitToTechnician`.
 *
 * NO es lo mismo que `SignalingRealtimeService`, que emite a la room de una
 * sesion remota y solo sirve para el relay de SDP/ICE. La diferencia importa:
 * un evento de dominio como el cierre de la sesion tiene que llegar al tecnico
 * aunque todavia no haya hecho `remote-session:join`, asi que se dirige a su
 * room personal y no a la de la sesion.
 *
 * Va en un modulo propio, sin dependencias, para que quien emite no tenga que
 * importar `SignalingModule` y no aparezcan dependencias circulares.
 *
 * La room la resuelve el adaptador de Socket.IO, asi que el dia que haya varias
 * instancias con un adaptador compartido el evento seguira llegando aunque el
 * tecnico este conectado a otra instancia.
 */
@Injectable()
export class TechnicianRealtimeService {
  private readonly logger = new Logger(TechnicianRealtimeService.name);

  /** Lo deja el gateway en su `afterInit`. Sin el no hay a donde emitir. */
  private target: TechnicianEventTarget | null = null;

  /** Registra el namespace de tecnicos ya inicializado. */
  bind(target: TechnicianEventTarget): void {
    this.target = target;
  }

  /**
   * Envia un evento a todas las conexiones autenticadas del tecnico.
   *
   * Devuelve `false` cuando no hay transporte disponible todavia. Que devuelva
   * `true` solo significa que el evento se entrego al transporte: si la web no
   * esta conectada el evento se pierde, y ese es el comportamiento buscado. El
   * estado vive en PostgreSQL y se recupera por REST; Socket.IO solo adelanta
   * el aviso.
   */
  emitToTechnician(
    technicianId: string,
    event: string,
    payload: unknown,
  ): boolean {
    if (!this.target) {
      this.logger.warn(
        `No realtime transport available: event ${event} for technician ${technicianId} was not delivered`,
      );
      return false;
    }

    this.target.to(technicianRoom(technicianId)).emit(event, payload);

    return true;
  }
}
