import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import { AuthService } from '../../auth/auth.service';
import { User } from '../../auth/entities/user.entity';
import { ValidRoles } from '../../auth/interfaces/valid-roles';
import {
  JoinRemoteSessionAck,
  joinRejected,
  relayRejected,
  SignalingErrorCode,
  SignalingRelayAck,
} from '../interfaces/signaling-ack.interface';
import {
  SignalingIdentity,
  SignalingParticipant,
  SignalingSocketData,
} from '../interfaces/signaling-participant.interface';
import { SignalingRealtimeService } from '../realtime/signaling-realtime.service';
import {
  REMOTE_SESSION_JOIN_EVENT,
  WEBRTC_ANSWER_EVENT,
  WEBRTC_ICE_CANDIDATE_EVENT,
  WEBRTC_OFFER_EVENT,
} from '../signaling.events';
import { SignalingService } from '../signaling.service';

/** Namespace exclusivo de tecnicos. Las tablets tienen el suyo en `/devices`. */
export const TECHNICIANS_NAMESPACE = '/technicians';

/**
 * Roles que pueden abrir un socket de tecnico.
 *
 * Se comprueban contra `ValidRoles`, la fuente de verdad del proyecto: no hay
 * roles escritos como strings sueltos. Un usuario autenticado con cualquier otro
 * rol no entra en este namespace.
 *
 * Que `admin` entre no le da acceso a sesiones ajenas: la pertenencia se
 * comprueba sesion por sesion en `SignalingService`.
 */
export const TECHNICIAN_SOCKET_ROLES: readonly ValidRoles[] = [
  ValidRoles.admin,
  ValidRoles.tecnico,
];

/** Motivo unico de rechazo: no revela por que fallo la autenticacion. */
const UNAUTHORIZED_REASON = 'Unauthorized';

/**
 * Identidad del socket autenticado.
 *
 * Sale del JWT de usuario verificado contra la base de datos, nunca de lo que el
 * cliente envie en un payload: un `userId`, un `technicianId`, un `email` o unos
 * `roles` sueltos en el handshake no autentican nada.
 */
export interface TechnicianSocketContext {
  userId: string;
  roles: ValidRoles[];
}

interface TechnicianSocketData extends SignalingSocketData {
  technician?: TechnicianSocketContext;
}

type TechnicianSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  TechnicianSocketData
>;

type TechnicianNamespace = Namespace<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  TechnicianSocketData
>;

/**
 * Conexion realtime de la aplicacion del tecnico (Flutter Web).
 *
 * Existe unicamente para el signaling de WebRTC: aqui NO se lleva presencia de
 * tecnicos ni se persiste nada. Todo el trabajo lo hace `SignalingService`; este
 * gateway solo autentica el socket y traduce eventos de Socket.IO.
 *
 * CORS: el servidor de Socket.IO es uno solo para todos los namespaces, asi que
 * la configuracion no va en este decorador sino en el adaptador que instala
 * `main.ts` (`SocketIoAdapter`), configurable por variables de entorno.
 *
 * LIMITACION CONOCIDA: el rol y el `isActive` se comprueban al abrir el socket.
 * Si al tecnico se le retira el acceso despues, su socket sigue abierto hasta
 * que se desconecte (sus peticiones HTTP si dejan de funcionar de inmediato, y
 * cerrar la `RemoteSession` corta el signaling al instante). Cerrar por las
 * bravas las conexiones de un tecnico exigiria un registro de presencia de
 * tecnicos, que este paso deja fuera a proposito.
 */
@WebSocketGateway({ namespace: TECHNICIANS_NAMESPACE })
export class TechniciansGateway
  implements
    OnGatewayInit<TechnicianNamespace>,
    OnGatewayConnection<TechnicianSocket>
{
  private readonly logger = new Logger(TechniciansGateway.name);

  constructor(
    private readonly authService: AuthService,
    private readonly signalingService: SignalingService,
    private readonly signalingRealtimeService: SignalingRealtimeService,
  ) {}

  /**
   * Igual que en `DevicesGateway`, la autenticacion va en un middleware del
   * namespace y no en `handleConnection`: la conexion se rechaza antes de
   * establecerse, el cliente recibe un `connect_error` y un socket sin identidad
   * nunca llega a existir.
   */
  afterInit(namespace: TechnicianNamespace): void {
    // A partir de aqui el signaling puede hacer llegar eventos a la room de
    // tecnicos de una sesion sin conocer este gateway.
    this.signalingRealtimeService.bindTechnicianNamespace(namespace);

    namespace.use((socket, next) => {
      void this.authenticate(socket).then(
        () => next(),
        () => next(new Error(UNAUTHORIZED_REASON)),
      );
    });
  }

  handleConnection(client: TechnicianSocket): void {
    const context = client.data.technician;

    // Sin identidad no paso por el middleware: no deberia ocurrir.
    if (!context) {
      client.disconnect(true);
      return;
    }

    this.logger.log(`Technician connected: ${context.userId}`);
  }

  /**
   * El tecnico entra en la sesion remota que va a controlar.
   *
   * Es obligatorio antes de enviar cualquier `webrtc:*`.
   */
  @SubscribeMessage(REMOTE_SESSION_JOIN_EVENT)
  handleJoinRemoteSession(
    @ConnectedSocket() client: TechnicianSocket,
    @MessageBody() payload: unknown,
  ): Promise<JoinRemoteSessionAck> {
    const identity = this.identityOf(client);

    if (!identity)
      return Promise.resolve(joinRejected(SignalingErrorCode.UNAUTHORIZED));

    return this.signalingService.join(client, identity, payload);
  }

  @SubscribeMessage(WEBRTC_OFFER_EVENT)
  handleOffer(
    @ConnectedSocket() client: TechnicianSocket,
    @MessageBody() payload: unknown,
  ): Promise<SignalingRelayAck> {
    const identity = this.identityOf(client);

    if (!identity)
      return Promise.resolve(relayRejected(SignalingErrorCode.UNAUTHORIZED));

    return this.signalingService.relayOffer(client, identity, payload);
  }

  @SubscribeMessage(WEBRTC_ANSWER_EVENT)
  handleAnswer(
    @ConnectedSocket() client: TechnicianSocket,
    @MessageBody() payload: unknown,
  ): Promise<SignalingRelayAck> {
    const identity = this.identityOf(client);

    if (!identity)
      return Promise.resolve(relayRejected(SignalingErrorCode.UNAUTHORIZED));

    return this.signalingService.relayAnswer(client, identity, payload);
  }

  @SubscribeMessage(WEBRTC_ICE_CANDIDATE_EVENT)
  handleIceCandidate(
    @ConnectedSocket() client: TechnicianSocket,
    @MessageBody() payload: unknown,
  ): Promise<SignalingRelayAck> {
    const identity = this.identityOf(client);

    if (!identity)
      return Promise.resolve(relayRejected(SignalingErrorCode.UNAUTHORIZED));

    return this.signalingService.relayIceCandidate(client, identity, payload);
  }

  /**
   * Identidad con la que el signaling autoriza: siempre la del token validado.
   *
   * Nunca se construye con datos del payload del evento.
   */
  private identityOf(client: TechnicianSocket): SignalingIdentity | null {
    const context = client.data.technician;

    if (!context) return null;

    return {
      participant: SignalingParticipant.TECHNICIAN,
      id: context.userId,
    };
  }

  /**
   * Valida el JWT de usuario del handshake y deja la identidad en el socket.
   *
   * Reutiliza `AuthService.authenticateToken`, el mismo camino que la estrategia
   * HTTP: firma y vencimiento del token, usuario existente y `isActive`. Aqui
   * solo se anade lo especifico del namespace, que es el rol.
   */
  private async authenticate(socket: TechnicianSocket): Promise<void> {
    const token = this.extractToken(socket);

    if (!token) throw new Error(UNAUTHORIZED_REASON);

    const user = await this.authService.authenticateToken(token);

    if (!this.isTechnician(user)) throw new Error(UNAUTHORIZED_REASON);

    socket.data.technician = { userId: user.id, roles: user.roles };
  }

  /** Los roles se leen del usuario recien consultado, no del token. */
  private isTechnician(user: User): boolean {
    return user.roles.some((role) => TECHNICIAN_SOCKET_ROLES.includes(role));
  }

  /**
   * Solo se acepta `auth.token`.
   *
   * Mismo criterio que en `/devices`: la identidad sale exclusivamente del token
   * validado.
   */
  private extractToken(socket: TechnicianSocket): string | null {
    const { token } = socket.handshake.auth as { token?: unknown };

    return typeof token === 'string' && token.length > 0 ? token : null;
  }
}
