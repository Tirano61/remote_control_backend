import { Injectable, Logger } from '@nestjs/common';
import { remoteSessionRoom } from '../signaling.events';
import { SignalingParticipant } from '../interfaces/signaling-participant.interface';

/**
 * Lo minimo que hace falta para emitir a una room.
 *
 * Igual que `DeviceEventTarget`, es una interfaz y no el `Namespace` de
 * Socket.IO: este servicio no depende de la libreria de transporte ni de los
 * gateways concretos.
 */
export interface SignalingEventTarget {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

/**
 * Salida de eventos de signaling hacia cada extremo.
 *
 * Los dos gateways registran aqui su namespace en `afterInit` (el de tablets y
 * el de tecnicos) y `SignalingService` emite sin conocer ninguno de los dos.
 * Asi el dominio no depende de clases Gateway concretas y no aparecen
 * dependencias circulares.
 *
 * El motivo de mantener dos referencias separadas es que en Socket.IO las rooms
 * son por namespace: `remote-session:<id>` en `/devices` y en `/technicians` son
 * rooms distintas, aunque se llamen igual. Emitir "al otro extremo" es por tanto
 * emitir a la misma room en el OTRO namespace.
 *
 * Efecto util: el emisor nunca recibe su propio mensaje, porque su socket vive
 * en el namespace de origen y la emision va solo al de destino.
 */
@Injectable()
export class SignalingRealtimeService {
  private readonly logger = new Logger(SignalingRealtimeService.name);

  /** Namespace `/devices`. Lo registra `DevicesGateway`. */
  private deviceNamespace: SignalingEventTarget | null = null;

  /** Namespace `/technicians`. Lo registra `TechniciansGateway`. */
  private technicianNamespace: SignalingEventTarget | null = null;

  bindDeviceNamespace(target: SignalingEventTarget): void {
    this.deviceNamespace = target;
  }

  bindTechnicianNamespace(target: SignalingEventTarget): void {
    this.technicianNamespace = target;
  }

  /** Emite a la room de la sesion dentro del namespace de dispositivos. */
  emitToDeviceSession(
    remoteSessionId: string,
    event: string,
    payload: unknown,
  ): boolean {
    return this.emit(
      this.deviceNamespace,
      SignalingParticipant.DEVICE,
      remoteSessionId,
      event,
      payload,
    );
  }

  /** Emite a la room de la sesion dentro del namespace de tecnicos. */
  emitToTechnicianSession(
    remoteSessionId: string,
    event: string,
    payload: unknown,
  ): boolean {
    return this.emit(
      this.technicianNamespace,
      SignalingParticipant.TECHNICIAN,
      remoteSessionId,
      event,
      payload,
    );
  }

  /**
   * Devuelve `false` si ese namespace todavia no esta disponible.
   *
   * `true` solo significa que el evento se entrego al transporte: si el otro
   * extremo no hizo `remote-session:join`, la room esta vacia y el mensaje se
   * pierde. El signaling es efimero a proposito y no se reintenta.
   */
  private emit(
    target: SignalingEventTarget | null,
    participant: SignalingParticipant,
    remoteSessionId: string,
    event: string,
    payload: unknown,
  ): boolean {
    if (!target) {
      this.logger.warn(
        `No realtime transport available for ${participant}: event ${event} of remote session ${remoteSessionId} was not delivered`,
      );
      return false;
    }

    target.to(remoteSessionRoom(remoteSessionId)).emit(event, payload);

    return true;
  }
}
