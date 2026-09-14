import { Injectable, Logger } from '@nestjs/common';
import { remoteSessionRoom } from '../signaling.events';
import { SignalingParticipant } from '../interfaces/signaling-participant.interface';

/**
 * Lo minimo que hace falta para emitir a una room y para saber quien esta en
 * ella.
 *
 * Igual que `DeviceEventTarget`, es una interfaz y no el `Namespace` de
 * Socket.IO: este servicio no depende de la libreria de transporte ni de los
 * gateways concretos. `fetchSockets()` es la forma que ofrece Socket.IO para
 * consultar una room sin tocar el adaptador por dentro, y funciona tambien si
 * algun dia hay varias instancias con un adaptador compartido.
 */
export interface SignalingRoomTarget {
  emit(event: string, payload: unknown): unknown;
  fetchSockets(): Promise<readonly unknown[]>;
}

export interface SignalingEventTarget {
  to(room: string): SignalingRoomTarget;
}

/**
 * Salida de eventos de signaling hacia cada extremo, y consulta de presencia en
 * la room de una sesion remota.
 *
 * Los dos gateways registran aqui su namespace en `afterInit` (el de tablets y
 * el de tecnicos) y `SignalingService` emite sin conocer ninguno de los dos.
 * Asi el dominio no depende de clases Gateway concretas y no aparecen
 * dependencias circulares.
 *
 * El motivo de mantener dos referencias separadas es que en Socket.IO las rooms
 * son por namespace: `remote-session:<id>` en `/devices` y en `/technicians` son
 * rooms distintas, aunque se llamen igual. Emitir "al otro extremo" es por tanto
 * emitir a la misma room en el OTRO namespace, y preguntar si el otro extremo
 * esta presente es mirar esa misma room en el OTRO namespace. Por eso la
 * consulta nombra siempre el namespace de forma explicita y nunca se apoya en
 * que Socket.IO los mezcle, porque no lo hace.
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

  /** Emite a la room de la sesion dentro del namespace de ese participante. */
  emitToParticipantSession(
    participant: SignalingParticipant,
    remoteSessionId: string,
    event: string,
    payload: unknown,
  ): boolean {
    return participant === SignalingParticipant.DEVICE
      ? this.emitToDeviceSession(remoteSessionId, event, payload)
      : this.emitToTechnicianSession(remoteSessionId, event, payload);
  }

  /**
   * ¿Hay al menos un socket de ese participante unido a la sesion?
   *
   * Es la unica fuente de readiness del signaling, para que los dos gateways no
   * inventen dos versiones distintas de la misma pregunta. Solo mira la room
   * `remote-session:<id>` DEL NAMESPACE de ese participante, asi que nunca
   * mezcla dos sesiones ni los dos extremos.
   *
   * Cuenta sockets, no participantes logicos: un tecnico con dos pestanas son
   * dos sockets en la misma room. Por eso el contrato publico solo expone un
   * boolean y jamas una cantidad.
   *
   * Devuelve `false` si el namespace todavia no esta registrado o si la consulta
   * falla: preferimos informar "el peer no esta" antes que afirmar una presencia
   * que no se ha podido comprobar.
   */
  async hasParticipantInSession(
    participant: SignalingParticipant,
    remoteSessionId: string,
  ): Promise<boolean> {
    const target =
      participant === SignalingParticipant.DEVICE
        ? this.deviceNamespace
        : this.technicianNamespace;

    if (!target) {
      this.logger.warn(
        `No realtime transport available for ${participant}: presence in remote session ${remoteSessionId} could not be checked`,
      );
      return false;
    }

    try {
      const sockets = await target
        .to(remoteSessionRoom(remoteSessionId))
        .fetchSockets();

      return sockets.length > 0;
    } catch (error) {
      this.logger.warn(
        `Could not check ${participant} presence in remote session ${remoteSessionId}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return false;
    }
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
