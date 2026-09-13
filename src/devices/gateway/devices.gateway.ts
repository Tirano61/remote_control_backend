import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import {
  JoinRemoteSessionAck,
  joinRejected,
  relayRejected,
  SignalingErrorCode,
  SignalingRelayAck,
} from '../../signaling/interfaces/signaling-ack.interface';
import {
  SignalingIdentity,
  SignalingParticipant,
  SignalingSocketData,
} from '../../signaling/interfaces/signaling-participant.interface';
import { SignalingRealtimeService } from '../../signaling/realtime/signaling-realtime.service';
import {
  REMOTE_SESSION_JOIN_EVENT,
  WEBRTC_ANSWER_EVENT,
  WEBRTC_ICE_CANDIDATE_EVENT,
  WEBRTC_OFFER_EVENT,
} from '../../signaling/signaling.events';
import { SignalingService } from '../../signaling/signaling.service';
import { DeviceAuthService } from '../auth/device-auth.service';
import { DevicePresenceService } from '../presence/device-presence.service';
import {
  DeviceRealtimeService,
  deviceRoom,
} from '../realtime/device-realtime.service';

/** Namespace exclusivo de tablets. Los tecnicos tendran el suyo aparte. */
export const DEVICES_NAMESPACE = '/devices';

/** Confirmacion que recibe la tablet tras autenticarse. */
export const DEVICE_CONNECTED_EVENT = 'device:connected';

/** Motivo unico de rechazo: no revela por que fallo la autenticacion. */
const UNAUTHORIZED_REASON = 'Unauthorized';

/**
 * Identidad del socket autenticado.
 *
 * Sale del Device JWT verificado contra la base de datos, nunca de lo que el
 * cliente envie despues en un payload.
 */
export interface DeviceSocketContext {
  deviceId: string;
  credentialId: string;
  publicId: string;
}

interface DeviceSocketData extends SignalingSocketData {
  device?: DeviceSocketContext;
}

type DeviceSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  DeviceSocketData
>;

type DeviceNamespace = Namespace<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  DeviceSocketData
>;

/**
 * Conexion persistente de los dispositivos Android.
 *
 * Mantiene la presencia (quien esta conectado y como cerrarle la conexion) y
 * registra el namespace en `DeviceRealtimeService`, que es por donde el resto
 * de modulos hace llegar eventos a una tablet.
 *
 * Es ademas el extremo "dispositivo" del signaling de WebRTC: los eventos
 * `remote-session:join` y `webrtc:*` se delegan integros en `SignalingService`,
 * que es quien valida la sesion y retransmite. Aqui no se interpreta ninguna
 * SDP ni ningun candidato ICE.
 */
@WebSocketGateway({ namespace: DEVICES_NAMESPACE })
export class DevicesGateway
  implements
    OnGatewayInit<DeviceNamespace>,
    OnGatewayConnection<DeviceSocket>,
    OnGatewayDisconnect<DeviceSocket>
{
  private readonly logger = new Logger(DevicesGateway.name);

  constructor(
    private readonly deviceAuthService: DeviceAuthService,
    private readonly devicePresenceService: DevicePresenceService,
    private readonly deviceRealtimeService: DeviceRealtimeService,
    private readonly signalingService: SignalingService,
    private readonly signalingRealtimeService: SignalingRealtimeService,
  ) {}

  /**
   * La autenticacion va en un middleware del namespace y no en
   * `handleConnection`: asi la conexion se rechaza antes de establecerse, el
   * cliente recibe un `connect_error` y un socket sin identidad nunca llega a
   * existir para el gateway.
   */
  afterInit(namespace: DeviceNamespace): void {
    // A partir de aqui otros modulos pueden emitir eventos a un dispositivo sin
    // conocer este gateway ni Socket.IO.
    this.deviceRealtimeService.bind(namespace);

    // Mismo mecanismo para el signaling: registra este namespace para que el
    // relay pueda alcanzar la room de la sesion en el lado del dispositivo.
    this.signalingRealtimeService.bindDeviceNamespace(namespace);

    namespace.use((socket, next) => {
      void this.authenticate(socket).then(
        () => next(),
        () => next(new Error(UNAUTHORIZED_REASON)),
      );
    });
  }

  async handleConnection(client: DeviceSocket): Promise<void> {
    const context = client.data.device;

    // Sin identidad no paso por el middleware: no deberia ocurrir.
    if (!context) {
      client.disconnect(true);
      return;
    }

    // La room la decide el servidor a partir del token validado: el cliente no
    // puede elegir la de otro dispositivo.
    await client.join(deviceRoom(context.deviceId));

    this.devicePresenceService.register(context.deviceId, client);

    // Si se desconecto mientras se autenticaba, `handleDisconnect` ya corrio y
    // no habia nada que dar de baja: se hace aqui para no dejar presencia
    // fantasma.
    if (client.disconnected) {
      this.devicePresenceService.unregister(context.deviceId, client.id);
      return;
    }

    client.emit(DEVICE_CONNECTED_EVENT, {
      deviceId: context.deviceId,
      publicId: context.publicId,
    });

    this.logger.log(`Device connected: ${context.publicId}`);
  }

  handleDisconnect(client: DeviceSocket): void {
    const context = client.data.device;

    if (!context) return;

    const isOffline = this.devicePresenceService.unregister(
      context.deviceId,
      client.id,
    );

    this.logger.log(
      `Device disconnected: ${context.publicId}${isOffline ? ' (OFFLINE)' : ''}`,
    );
  }

  /**
   * La tablet entra en la sesion remota que ya autorizo.
   *
   * Es obligatorio antes de enviar cualquier `webrtc:*`. La sesion tiene que ser
   * suya: se compara contra el `deviceId` del token, no contra nada del payload.
   */
  @SubscribeMessage(REMOTE_SESSION_JOIN_EVENT)
  handleJoinRemoteSession(
    @ConnectedSocket() client: DeviceSocket,
    @MessageBody() payload: unknown,
  ): Promise<JoinRemoteSessionAck> {
    const identity = this.identityOf(client);

    if (!identity)
      return Promise.resolve(joinRejected(SignalingErrorCode.UNAUTHORIZED));

    return this.signalingService.join(client, identity, payload);
  }

  @SubscribeMessage(WEBRTC_OFFER_EVENT)
  handleOffer(
    @ConnectedSocket() client: DeviceSocket,
    @MessageBody() payload: unknown,
  ): Promise<SignalingRelayAck> {
    const identity = this.identityOf(client);

    if (!identity)
      return Promise.resolve(relayRejected(SignalingErrorCode.UNAUTHORIZED));

    return this.signalingService.relayOffer(client, identity, payload);
  }

  @SubscribeMessage(WEBRTC_ANSWER_EVENT)
  handleAnswer(
    @ConnectedSocket() client: DeviceSocket,
    @MessageBody() payload: unknown,
  ): Promise<SignalingRelayAck> {
    const identity = this.identityOf(client);

    if (!identity)
      return Promise.resolve(relayRejected(SignalingErrorCode.UNAUTHORIZED));

    return this.signalingService.relayAnswer(client, identity, payload);
  }

  @SubscribeMessage(WEBRTC_ICE_CANDIDATE_EVENT)
  handleIceCandidate(
    @ConnectedSocket() client: DeviceSocket,
    @MessageBody() payload: unknown,
  ): Promise<SignalingRelayAck> {
    const identity = this.identityOf(client);

    if (!identity)
      return Promise.resolve(relayRejected(SignalingErrorCode.UNAUTHORIZED));

    return this.signalingService.relayIceCandidate(client, identity, payload);
  }

  /**
   * Identidad con la que el signaling autoriza: la del Device JWT validado.
   *
   * Nunca se construye con datos del payload del evento.
   */
  private identityOf(client: DeviceSocket): SignalingIdentity | null {
    const context = client.data.device;

    if (!context) return null;

    return { participant: SignalingParticipant.DEVICE, id: context.deviceId };
  }

  /**
   * Valida el Device JWT del handshake y deja la identidad en el socket.
   *
   * Reutiliza `DeviceAuthService`, la misma logica que usa la estrategia HTTP:
   * firma, `tokenType`, dispositivo existente y activo, y credencial vigente
   * que pertenezca al dispositivo.
   */
  private async authenticate(socket: DeviceSocket): Promise<void> {
    const token = this.extractToken(socket);

    if (!token) throw new Error(UNAUTHORIZED_REASON);

    const { device, credentialId } =
      await this.deviceAuthService.authenticateToken(token);

    socket.data.device = {
      deviceId: device.id,
      credentialId,
      publicId: device.publicId,
    };
  }

  /**
   * Solo se acepta `auth.token`.
   *
   * Un `deviceId`, un `publicId` o un `deviceSecret` sueltos en el handshake no
   * autentican nada: la identidad sale exclusivamente del token validado.
   */
  private extractToken(socket: DeviceSocket): string | null {
    const { token } = socket.handshake.auth as { token?: unknown };

    return typeof token === 'string' && token.length > 0 ? token : null;
  }
}
