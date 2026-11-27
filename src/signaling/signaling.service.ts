import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { In, Repository } from 'typeorm';
import { RemoteSession } from '../remote-sessions/entities/remote-session.entity';
import { ACTIVE_REMOTE_SESSION_STATUSES } from '../remote-sessions/enums/remote-session-status.enum';
import { JoinRemoteSessionDto } from './dto/join-remote-session.dto';
import { WebrtcIceCandidateDto } from './dto/webrtc-ice-candidate.dto';
import { WebrtcSdpDto } from './dto/webrtc-sdp.dto';
import {
  JoinRemoteSessionAck,
  joinRejected,
  relayRejected,
  SignalingErrorCode,
  SignalingRelayAck,
} from './interfaces/signaling-ack.interface';
import {
  peerOf,
  SignalingIdentity,
  SignalingParticipant,
  SignalingSocket,
} from './interfaces/signaling-participant.interface';
import { SessionParticipationService } from './participation/session-participation.service';
import { SignalingRealtimeService } from './realtime/signaling-realtime.service';
import {
  REMOTE_SESSION_PEER_JOINED_EVENT,
  remoteSessionRoom,
  RemoteSessionPeerJoinedPayload,
  WEBRTC_ANSWER_EVENT,
  WEBRTC_ICE_CANDIDATE_EVENT,
  WEBRTC_OFFER_EVENT,
  WebrtcIceCandidatePayload,
  WebrtcSdpPayload,
} from './signaling.events';

/**
 * Servidor de signaling: valida participantes y retransmite SDP/ICE.
 *
 * NestJS no transporta video, audio ni DataChannel; unicamente ayuda a los dos
 * extremos a encontrarse. Nada de lo que pasa por aqui se persiste: la SDP y
 * los candidatos ICE son informacion efimera y no tienen tabla.
 *
 * Depende de la entidad `RemoteSession` por TypeORM y NO de
 * `RemoteSessionsService`: solo necesita LEER `deviceId`, `technicianId` y
 * `status` para autorizar, nunca alterar la sesion (en particular, el
 * intercambio de signaling no la pasa a `ACTIVE`). Asi tampoco aparecen
 * dependencias circulares entre el modulo de dispositivos, el de sesiones
 * remotas y el realtime de tecnicos.
 *
 * Es neutral respecto a la direccion: tanto el tecnico como la tablet pueden
 * crear la offer. Quien la crea lo decidiran los clientes cuando se implemente
 * WebRTC de verdad.
 */
@Injectable()
export class SignalingService {
  private readonly logger = new Logger(SignalingService.name);

  constructor(
    @InjectRepository(RemoteSession)
    private readonly remoteSessionRepository: Repository<RemoteSession>,

    private readonly signalingRealtimeService: SignalingRealtimeService,

    // Registro de quien esta unido a cada sesion. Es la senal que usa el cierre
    // automatico por abandono; solo se escribe desde aqui, con la identidad del
    // socket autenticado y despues de validar el join.
    private readonly sessionParticipationService: SessionParticipationService,
  ) {}

  /**
   * El participante se une a la room de signaling de su sesion.
   *
   * Es obligatorio antes de cualquier `webrtc:*`, y el nombre de la room lo
   * decide el servidor: el cliente solo envia un `remoteSessionId`.
   *
   * Un socket participa en UNA sesion a la vez. Si ya estaba en otra, la
   * abandona antes de validar la nueva; si la nueva no es valida, el socket
   * queda sin sesion y tendra que volver a unirse. El payload se valida antes de
   * tocar nada: un mensaje mal formado no debe sacar a nadie de su sesion.
   *
   * El ACK incluye ademas `peerJoined`, que es lo que quita la carrera inicial
   * de la negociacion: sin el, el primero en llegar podria mandar su offer a una
   * room vacia y perderla, porque el signaling no se guarda en ningun sitio. Es
   * readiness de signaling y nada mas: NO significa WebRTC conectado, ni ICE
   * terminado, ni sesion `ACTIVE`, ni video disponible.
   *
   * Si el peer llega despues, se le avisa a este con
   * `remote-session:peer-joined` en lugar de obligarle a repetir el join.
   */
  async join(
    socket: SignalingSocket,
    identity: SignalingIdentity,
    payload: unknown,
  ): Promise<JoinRemoteSessionAck> {
    const dto = await this.toDto(JoinRemoteSessionDto, payload);

    if (!dto) return joinRejected(SignalingErrorCode.INVALID_PAYLOAD);

    await this.leaveCurrentSession(socket, identity);

    // Una identidad ya revocada ni siquiera consulta la base de datos.
    if (!identity.isCurrent())
      return joinRejected(SignalingErrorCode.UNAUTHORIZED);

    // La sesion y la identidad se leen de PostgreSQL en cada join: que el
    // handshake fuera valido no dice si el dispositivo sigue activo, su
    // credencial vigente o el tecnico habilitado AHORA.
    const [remoteSession, identityAuthorized] = await Promise.all([
      this.findJoinableSession(dto.remoteSessionId, identity),
      identity.revalidate(),
    ]);

    // Mismo criterio que en REST: una sesion ajena, inexistente o cerrada
    // responde igual. Conocer el UUID no autoriza nada ni confirma que exista.
    // Una identidad revocada responde exactamente lo mismo.
    if (!remoteSession || !identityAuthorized)
      return joinRejected(SignalingErrorCode.UNAUTHORIZED);

    // Antes de entrar: si ya habia otro socket de ESTE mismo extremo en la room,
    // el otro lado ya fue avisado en su momento y no hace falta repetirselo. Es
    // lo que evita que una segunda pestana del tecnico dispare un aviso extra.
    const ownSideWasPresent =
      await this.signalingRealtimeService.hasParticipantInSession(
        identity.participant,
        remoteSession.id,
      );

    await socket.join(remoteSessionRoom(remoteSession.id));

    // Si el socket se desconecto durante los `await` anteriores, su
    // `handleDisconnect` ya corrio sin sesion que dar de baja: registrarlo ahora
    // dejaria un participante fantasma que mantendria viva la sesion.
    //
    // Y si su identidad se revoco durante esos `await`, las lecturas de arriba
    // son anteriores a la revocacion y ya no valen: no se concede la entrada.
    // Entre esta comprobacion y el registro de la participacion no hay ningun
    // `await`.
    if (socket.disconnected || !identity.isCurrent()) {
      await socket.leave(remoteSessionRoom(remoteSession.id));
      return joinRejected(SignalingErrorCode.UNAUTHORIZED);
    }

    socket.data.remoteSessionId = remoteSession.id;

    // Participacion efectiva: es lo unico que cancela un periodo de gracia en
    // curso, y solo se llega aqui con la sesion validada (viva y del que la
    // pide). Un socket autenticado que no hace join no cuenta.
    this.sessionParticipationService.join(
      remoteSession.id,
      identity.participant,
      socket.id,
    );

    // Solo se llega aqui con la sesion ya validada: viva y del que la pide. Un
    // socket no autorizado no produce readiness ni avisa a nadie.
    const peerJoined =
      await this.signalingRealtimeService.hasParticipantInSession(
        peerOf(identity.participant),
        remoteSession.id,
      );

    // Revocado (o desconectado, o cambiado de sesion) mientras se consultaba al
    // peer: ni se le anuncia nada ni se confirma el join. Si el barrido ya cerro
    // el socket, `handleDisconnect` dio de baja la participacion; si no, se da
    // de baja aqui.
    if (
      socket.disconnected ||
      !identity.isCurrent() ||
      socket.data.remoteSessionId !== remoteSession.id
    ) {
      if (socket.data.remoteSessionId === remoteSession.id)
        await this.leaveCurrentSession(socket, identity);

      return joinRejected(SignalingErrorCode.UNAUTHORIZED);
    }

    if (peerJoined && !ownSideWasPresent)
      this.announceToPeer(identity, remoteSession.id);

    this.logger.log(
      `${identity.participant} joined signaling of remote session ${remoteSession.id} (peerJoined=${peerJoined})`,
    );

    return { joined: true, remoteSessionId: remoteSession.id, peerJoined };
  }

  /** Retransmite una SDP offer al otro extremo de la sesion. */
  relayOffer(
    socket: SignalingSocket,
    identity: SignalingIdentity,
    payload: unknown,
  ): Promise<SignalingRelayAck> {
    return this.relaySdp(socket, identity, payload, WEBRTC_OFFER_EVENT);
  }

  /** Retransmite una SDP answer al otro extremo de la sesion. */
  relayAnswer(
    socket: SignalingSocket,
    identity: SignalingIdentity,
    payload: unknown,
  ): Promise<SignalingRelayAck> {
    return this.relaySdp(socket, identity, payload, WEBRTC_ANSWER_EVENT);
  }

  /** Retransmite un candidato ICE al otro extremo de la sesion. */
  async relayIceCandidate(
    socket: SignalingSocket,
    identity: SignalingIdentity,
    payload: unknown,
  ): Promise<SignalingRelayAck> {
    const dto = await this.toDto(WebrtcIceCandidateDto, payload);

    if (!dto) return relayRejected(SignalingErrorCode.INVALID_PAYLOAD);

    const error = await this.authorizeRelay(
      socket,
      identity,
      dto.remoteSessionId,
    );

    if (error) return relayRejected(error);

    const relayed: WebrtcIceCandidatePayload = {
      remoteSessionId: dto.remoteSessionId,
      from: identity.participant,
      candidate: dto.candidate,
      sdpMid: dto.sdpMid ?? null,
      sdpMLineIndex: dto.sdpMLineIndex ?? null,
    };

    return this.emitToPeer(
      socket,
      identity,
      dto.remoteSessionId,
      WEBRTC_ICE_CANDIDATE_EVENT,
      relayed,
    );
  }

  /**
   * El socket se desconecto: deja de participar en la sesion a la que estaba
   * unido.
   *
   * Socket.IO ya lo saca de sus rooms; aqui solo se da de baja en el registro de
   * participantes. La sesion sale del valor que el servidor escribio en el
   * socket al validar el join, nunca de un payload. Si era el ultimo socket de
   * ese extremo en la sesion, empieza su periodo de gracia.
   */
  handleDisconnect(socket: SignalingSocket, identity: SignalingIdentity): void {
    const current = socket.data.remoteSessionId;

    if (!current) return;

    socket.data.remoteSessionId = null;

    this.sessionParticipationService.leave(
      current,
      identity.participant,
      socket.id,
    );
  }

  /**
   * Cambio de sesion dentro de un mismo socket: abandona la room anterior y deja
   * de participar en ella. (Un socket desaparece de sus rooms solo con
   * desconectarse; eso lo cubre `handleDisconnect`.)
   */
  private async leaveCurrentSession(
    socket: SignalingSocket,
    identity: SignalingIdentity,
  ): Promise<void> {
    const current = socket.data.remoteSessionId;

    if (!current) return;

    socket.data.remoteSessionId = null;

    this.sessionParticipationService.leave(
      current,
      identity.participant,
      socket.id,
    );

    await socket.leave(remoteSessionRoom(current));
  }

  /**
   * `webrtc:offer` y `webrtc:answer` comparten payload y reglas: solo cambia el
   * nombre del evento que llega al otro extremo.
   */
  private async relaySdp(
    socket: SignalingSocket,
    identity: SignalingIdentity,
    payload: unknown,
    event: string,
  ): Promise<SignalingRelayAck> {
    const dto = await this.toDto(WebrtcSdpDto, payload);

    if (!dto) return relayRejected(SignalingErrorCode.INVALID_PAYLOAD);

    const error = await this.authorizeRelay(
      socket,
      identity,
      dto.remoteSessionId,
    );

    if (error) return relayRejected(error);

    const relayed: WebrtcSdpPayload = {
      remoteSessionId: dto.remoteSessionId,
      from: identity.participant,
      sdp: dto.sdp,
    };

    return this.emitToPeer(
      socket,
      identity,
      dto.remoteSessionId,
      event,
      relayed,
    );
  }

  /**
   * Revalidacion por evento.
   *
   * No basta con que el `remote-session:join` fuera valido hace unos minutos: la
   * sesion pudo cerrarse desde entonces, y la identidad del socket pudo perder
   * la autorizacion (dispositivo desactivado o re-enrolado, tecnico
   * deshabilitado). Cada mensaje comprueba de nuevo que el socket esta unido a
   * ESA sesion, que la sesion sigue viva y siendo suya, y que su identidad sigue
   * autorizada en PostgreSQL, de modo que un `CLOSED` o una revocacion cortan el
   * signaling de inmediato.
   *
   * Pertenecer a la room no autoriza nada por si solo: un socket que sigue en
   * ella porque se unio antes de una revocacion no pasa de aqui.
   */
  private async authorizeRelay(
    socket: SignalingSocket,
    identity: SignalingIdentity,
    remoteSessionId: string,
  ): Promise<SignalingErrorCode | null> {
    // La sesion del socket la escribio el servidor al validar el join: es lo
    // que impide mandar signaling a una sesion cuyo UUID se conoce pero a la que
    // no se hizo join, o desde un socket unido a otra sesion.
    if (socket.data.remoteSessionId !== remoteSessionId)
      return SignalingErrorCode.NOT_JOINED;

    if (!identity.isCurrent()) return SignalingErrorCode.UNAUTHORIZED;

    const [remoteSession, identityAuthorized] = await Promise.all([
      this.findJoinableSession(remoteSessionId, identity),
      identity.revalidate(),
    ]);

    return remoteSession && identityAuthorized
      ? null
      : SignalingErrorCode.UNAUTHORIZED;
  }

  /**
   * Ultima comprobacion antes de un efecto, SIN I/O.
   *
   * Las lecturas de `authorizeRelay` pudieron hacerse antes de una revocacion
   * que confirmo mientras se esperaban. Esta comprobacion es sincrona y va
   * justo antes de emitir, sin ningun `await` entre medias: si la revocacion
   * llego, la barrera ya esta levantada y el mensaje no sale.
   */
  private stillAuthorized(
    socket: SignalingSocket,
    identity: SignalingIdentity,
    remoteSessionId: string,
  ): SignalingErrorCode | null {
    if (socket.disconnected || !identity.isCurrent())
      return SignalingErrorCode.UNAUTHORIZED;

    // Cambio de sesion en el mismo socket mientras se revalidaba.
    if (socket.data.remoteSessionId !== remoteSessionId)
      return SignalingErrorCode.NOT_JOINED;

    return null;
  }

  /**
   * Sesion viva que pertenece a quien la pide, o `null`.
   *
   * La pertenencia y el estado viajan en el WHERE, como en
   * `RemoteSessionsService`: un `admin` no queda por encima de la regla, porque
   * lo que se compara es el `technicianId` de la sesion. Los estados aceptados
   * salen de `ACTIVE_REMOTE_SESSION_STATUSES`, asi que una sesion `CLOSED` nunca
   * aparece.
   *
   * Es una lectura: el signaling no modifica la sesion.
   */
  private findJoinableSession(
    remoteSessionId: string,
    identity: SignalingIdentity,
  ): Promise<RemoteSession | null> {
    const owner =
      identity.participant === SignalingParticipant.DEVICE
        ? { deviceId: identity.id }
        : { technicianId: identity.id };

    return this.remoteSessionRepository.findOne({
      where: {
        id: remoteSessionId,
        ...owner,
        status: In([...ACTIVE_REMOTE_SESSION_STATUSES]),
      },
      select: { id: true, deviceId: true, technicianId: true, status: true },
    });
  }

  /**
   * Avisa al otro extremo de que su peer ya esta en la room.
   *
   * Resuelve el caso en que el primero en llegar recibio `peerJoined: false`:
   * se entera sin repetir el join y sin esperar un tiempo inventado. No lleva
   * identidad del peer ni cantidad de sockets, y va a la room de ESTA sesion en
   * el namespace contrario, asi que nunca cruza sesiones.
   *
   * No devuelve nada ni rompe el join: que el aviso no llegue solo significa que
   * el peer se fue entre la consulta y la emision, y entonces tampoco habia nada
   * que anunciar. El cliente que recibe el evento dos veces (por ejemplo cuando
   * los dos extremos se unen a la vez) debe tratarlo como idempotente.
   */
  private announceToPeer(
    identity: SignalingIdentity,
    remoteSessionId: string,
  ): void {
    const payload: RemoteSessionPeerJoinedPayload = { remoteSessionId };

    this.signalingRealtimeService.emitToParticipantSession(
      peerOf(identity.participant),
      remoteSessionId,
      REMOTE_SESSION_PEER_JOINED_EVENT,
      payload,
    );
  }

  /**
   * Entrega el mensaje en el namespace del OTRO extremo.
   *
   * Nunca hay broadcast: el destino es la room de esa sesion y nada mas. Como el
   * emisor esta en el namespace contrario, tampoco recibe su propio mensaje.
   *
   * Lo primero, y sin ningun `await` antes de emitir, es `stillAuthorized`: una
   * revocacion confirmada mientras se revalidaba impide el envio.
   */
  private emitToPeer(
    socket: SignalingSocket,
    identity: SignalingIdentity,
    remoteSessionId: string,
    event: string,
    payload: WebrtcSdpPayload | WebrtcIceCandidatePayload,
  ): SignalingRelayAck {
    const refusal = this.stillAuthorized(socket, identity, remoteSessionId);

    if (refusal) return relayRejected(refusal);

    const delivered = this.signalingRealtimeService.emitToParticipantSession(
      peerOf(identity.participant),
      remoteSessionId,
      event,
      payload,
    );

    if (!delivered) return relayRejected(SignalingErrorCode.UNAVAILABLE);

    // Nunca se loguea la SDP ni el candidato: son datos de la conexion remota.
    this.logger.debug(
      `${event} relayed from ${identity.participant} on remote session ${remoteSessionId}`,
    );

    return { delivered: true, remoteSessionId };
  }

  /**
   * Valida el payload del evento con el DTO correspondiente.
   *
   * Mismas opciones que el `ValidationPipe` global de `main.ts`
   * (`whitelist` + `forbidNonWhitelisted`), pero aplicadas a mano: un handler de
   * Socket.IO debe responder SIEMPRE a su ACK, y una excepcion dejaria al
   * cliente esperando.
   */
  private async toDto<T extends object>(
    metatype: ClassConstructor<T>,
    payload: unknown,
  ): Promise<T | null> {
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    )
      return null;

    const dto = plainToInstance(metatype, payload);

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    return errors.length === 0 ? dto : null;
  }
}
