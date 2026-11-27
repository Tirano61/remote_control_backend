import { Logger, UnauthorizedException } from '@nestjs/common';
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
import {
  IdentityRevocationService,
  RevocableIdentityKind,
} from '../../revocation/identity-revocation.service';
import {
  DeviceAuthorizationStatus,
  DeviceAuthService,
} from '../auth/device-auth.service';
import { DevicePresenceService } from '../presence/device-presence.service';
import {
  DeviceRealtimeService,
  deviceRoom,
} from '../realtime/device-realtime.service';
import {
  classifyHandshakeFailure,
  describeHandshakeFailure,
  DeviceHandshakeError,
  DeviceHandshakeErrorCode,
} from './device-handshake-error';

/** Namespace exclusivo de tablets. Los tecnicos tendran el suyo aparte. */
export const DEVICES_NAMESPACE = '/devices';

/** Confirmacion que recibe la tablet tras autenticarse. */
export const DEVICE_CONNECTED_EVENT = 'device:connected';

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
  /**
   * Sello de `IdentityRevocationService` tomado ANTES de leer el dispositivo y
   * la credencial de PostgreSQL. Si el dispositivo se revoca despues
   * (desactivacion o re-enrolamiento), este socket deja de ser admisible aunque
   * su lectura dijera que estaba activo.
   */
  admittedAt: number;
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
    private readonly identityRevocationService: IdentityRevocationService,
  ) {}

  /**
   * La autenticacion va en un middleware del namespace y no en
   * `handleConnection`: asi la conexion se rechaza antes de establecerse, el
   * cliente recibe un `connect_error` y un socket sin identidad nunca llega a
   * existir para el gateway.
   *
   * El `connect_error` distingue dos casos (ver `device-handshake-error.ts`):
   * el token fue comprobado y rechazado (`DEVICE_AUTH_UNAUTHORIZED`), o no se
   * pudo comprobar (`DEVICE_AUTH_UNAVAILABLE`). Los dos rechazan el handshake;
   * la identidad solo se asigna al socket cuando la autenticacion termino bien.
   *
   * REVOCACION (auditoria Prompt 44, C1). La autenticacion lee el dispositivo y
   * su credencial con varios `await`; una desactivacion puede confirmar en
   * medio. Por eso el middleware toma un sello de la barrera ANTES de leer nada
   * y, al terminar, rechaza el handshake si el dispositivo se revoco despues de
   * ese sello. `handleConnection` vuelve a comprobarlo justo antes de registrar
   * la presencia, sin `await` entre ambas cosas. Ver
   * `IdentityRevocationService`.
   */
  afterInit(namespace: DeviceNamespace): void {
    // A partir de aqui otros modulos pueden emitir eventos a un dispositivo sin
    // conocer este gateway ni Socket.IO.
    this.deviceRealtimeService.bind(namespace);

    // Mismo mecanismo para el signaling: registra este namespace para que el
    // relay pueda alcanzar la room de la sesion en el lado del dispositivo.
    this.signalingRealtimeService.bindDeviceNamespace(namespace);

    namespace.use((socket, next) => {
      // El sello va ANTES de cualquier lectura de PostgreSQL.
      const stamp = this.identityRevocationService.stamp();

      void this.authenticate(socket).then(
        (context) => {
          // La lectura es anterior a una revocacion ya confirmada: no vale.
          if (!this.isAdmissible(context.deviceId, stamp))
            return next(DeviceHandshakeError.unauthorized());

          socket.data.device = { ...context, admittedAt: stamp };
          next();
        },
        (error: unknown) => {
          const refusal = classifyHandshakeFailure(error);

          // Un rechazo del token es rutina (tokens vencidos, re-enrolamientos) y
          // no se registra. No poder comprobarlo es un problema del servidor:
          // se registra solo el tipo y el codigo del fallo, nunca su mensaje
          // (puede llevar la consulta) ni nada del handshake (lleva el token).
          if (refusal.code === DeviceHandshakeErrorCode.UNAVAILABLE)
            this.logger.warn(
              `Device handshake refused, authentication unavailable: ${describeHandshakeFailure(error)}`,
            );

          next(refusal);
        },
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

    // Si se desconecto mientras se unia a la room, `handleDisconnect` ya corrio
    // y no habia nada que dar de baja: no se registra, para no dejar presencia
    // fantasma. Se comprueba ANTES de registrar (y sin `await` entre medias) para
    // no anunciar a los tecnicos un ONLINE seguido de un OFFLINE que nunca fue
    // presencia real.
    if (client.disconnected) return;

    // Revocado mientras entraba en su room: el barrido de la revocacion no lo
    // encontro registrado y no lo cerro. Se cierra aqui, y la comprobacion y el
    // registro de abajo ocurren sin ningun `await` entre medias, asi que una
    // revocacion no puede colarse entre ambos.
    if (!this.isAdmissible(context.deviceId, context.admittedAt)) {
      client.disconnect(true);
      return;
    }

    // Registrar es lo que avisa `device:presence-updated` si era el primer
    // socket: la presencia ya esta actualizada cuando sale el aviso.
    this.devicePresenceService.register(context.deviceId, client);

    client.emit(DEVICE_CONNECTED_EVENT, {
      deviceId: context.deviceId,
      publicId: context.publicId,
    });

    this.logger.log(`Device connected: ${context.publicId}`);
  }

  handleDisconnect(client: DeviceSocket): void {
    const context = client.data.device;

    if (!context) return;

    // Participacion en la sesion remota: se da de baja SIEMPRE, tambien cuando
    // la presencia ya lo saco (desconexion forzada). Si era el ultimo socket de
    // la tablet unido a la sesion, empieza su periodo de gracia.
    const identity = this.identityOf(client);

    if (identity) this.signalingService.handleDisconnect(client, identity);

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

    return {
      participant: SignalingParticipant.DEVICE,
      id: context.deviceId,
      revalidate: () => this.revalidate(client, context),
      isCurrent: () =>
        !client.disconnected &&
        this.isAdmissible(context.deviceId, context.admittedAt),
    };
  }

  private isAdmissible(deviceId: string, stamp: number): boolean {
    return this.identityRevocationService.isAdmissible(
      RevocableIdentityKind.DEVICE,
      deviceId,
      stamp,
    );
  }

  /**
   * Estado ACTUAL del dispositivo y de la credencial del socket en PostgreSQL.
   *
   * - Dispositivo inactivo o inexistente: se revoca toda su identidad (cierra
   *   todos sus sockets y el cierre automatico termina su sesion viva). Es lo que
   *   ocurre si se desactivo sin pasar por `PATCH /devices/:id`.
   * - Credencial que ya no es la vigente: solo pierde el acceso este socket. El
   *   dispositivo puede tener otro, legitimo, con su credencial nueva.
   *
   * Un fallo de la base de datos no es un rechazo y sale tal cual.
   */
  private async revalidate(
    client: DeviceSocket,
    context: DeviceSocketContext,
  ): Promise<boolean> {
    const status = await this.deviceAuthService.checkAuthorization(
      context.deviceId,
      context.credentialId,
    );

    if (status === DeviceAuthorizationStatus.AUTHORIZED) return true;

    this.logger.warn(
      `Device ${context.publicId} failed realtime revalidation (${status}): access revoked`,
    );

    if (status === DeviceAuthorizationStatus.DEVICE_REVOKED)
      this.identityRevocationService.revoke(
        RevocableIdentityKind.DEVICE,
        context.deviceId,
      );
    else client.disconnect(true);

    return false;
  }

  /**
   * Valida el Device JWT del handshake y devuelve la identidad del socket.
   *
   * Reutiliza `DeviceAuthService`, la misma logica que usa la estrategia HTTP:
   * firma, `tokenType`, dispositivo existente y activo, y credencial vigente
   * que pertenezca al dispositivo.
   *
   * Un rechazo sale como `UnauthorizedException`; cualquier otro error (de la
   * base de datos, por ejemplo) sale tal cual, y el middleware lo clasifica
   * como "no disponible".
   */
  private async authenticate(
    socket: DeviceSocket,
  ): Promise<Omit<DeviceSocketContext, 'admittedAt'>> {
    const token = this.extractToken(socket);

    if (!token) throw new UnauthorizedException();

    const { device, credentialId } =
      await this.deviceAuthService.authenticateToken(token);

    return {
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
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const token = auth?.token;

    return typeof token === 'string' && token.length > 0 ? token : null;
  }
}
