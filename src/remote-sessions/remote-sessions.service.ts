import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { Device } from '../devices/entities/device.entity';
import { DevicePresenceService } from '../devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../devices/realtime/device-realtime.service';
import { SupportRequestTechnicianDto } from '../support-requests/dto/support-request-response.dto';
import { SupportRequest } from '../support-requests/entities/support-request.entity';
import { SupportRequestStatus } from '../support-requests/enums/support-request-status.enum';
import { CreateRemoteSessionDto } from './dto/create-remote-session.dto';
import {
  CurrentRemoteSessionResponseDto,
  RemoteSessionResponseDto,
} from './dto/remote-session-response.dto';
import {
  ACTIVE_REMOTE_SESSION_INDEX,
  RemoteSession,
} from './entities/remote-session.entity';
import { RemoteSessionEndedBy } from './enums/remote-session-ended-by.enum';
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  RemoteSessionStatus,
} from './enums/remote-session-status.enum';

/** Aviso a la tablet de que el tecnico inicio la asistencia. */
export const REMOTE_SESSION_CREATED_EVENT = 'remote-session:created';

/** Aviso a la tablet de que la sesion termino. */
export const REMOTE_SESSION_CLOSED_EVENT = 'remote-session:closed';

/** Payload de `remote-session:created`. Sin email, sin roles y sin tokens. */
export interface RemoteSessionCreatedPayload {
  remoteSessionId: string;
  supportRequestId: string;
  technician: SupportRequestTechnicianDto;
}

/** Payload de `remote-session:closed`. */
export interface RemoteSessionClosedPayload {
  remoteSessionId: string;
  endedBy: RemoteSessionEndedBy;
}

/** Forma minima del error que devuelve el driver de PostgreSQL. */
interface PostgresError {
  code?: string;
  constraint?: string;
}

/** unique_violation */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class RemoteSessionsService {
  private readonly logger = new Logger(RemoteSessionsService.name);

  constructor(
    @InjectRepository(RemoteSession)
    private readonly remoteSessionRepository: Repository<RemoteSession>,

    @InjectRepository(SupportRequest)
    private readonly supportRequestRepository: Repository<SupportRequest>,

    private readonly dataSource: DataSource,

    private readonly devicePresenceService: DevicePresenceService,

    private readonly deviceRealtimeService: DeviceRealtimeService,
  ) {}

  // ---------------------------------------------------------------------------
  // Tecnicos / admin (JWT de usuario)
  // ---------------------------------------------------------------------------

  /**
   * El tecnico inicia la asistencia sobre una solicitud que la tablet acepto.
   *
   * Del cliente llega unicamente `supportRequestId`: el dispositivo sale de la
   * solicitud y el tecnico del token. Un `admin` usa el mismo endpoint pero no
   * queda por encima de la regla, tambien tiene que ser el tecnico asignado: de
   * momento no existe supervision ni takeover administrativo.
   */
  async create(
    createRemoteSessionDto: CreateRemoteSessionDto,
    user: User,
  ): Promise<RemoteSessionResponseDto> {
    const { supportRequestId } = createRemoteSessionDto;

    // La pertenencia va en el WHERE y no en un `if` posterior: la solicitud de
    // otro tecnico se comporta como inexistente y no se confirma que exista.
    const supportRequest = await this.supportRequestRepository.findOne({
      where: { id: supportRequestId, technicianId: user.id },
      relations: { device: true },
    });

    if (!supportRequest)
      throw new NotFoundException(
        `Support request with id ${supportRequestId} not found`,
      );

    // Solo una solicitud aceptada autoriza el control remoto: el usuario de la
    // tablet tuvo que autorizar expresamente a ese tecnico.
    if (supportRequest.status !== SupportRequestStatus.ACCEPTED)
      throw new ConflictException(
        `Support request with id ${supportRequestId} was not accepted by the device`,
      );

    // Una tablet desconectada no puede establecer nada. La solicitud NO se
    // toca: sigue ACCEPTED para que el tecnico reintente al reconectarse.
    if (!this.devicePresenceService.isOnline(supportRequest.deviceId))
      throw new ConflictException(
        `Device with id ${supportRequest.deviceId} is offline`,
      );

    const remoteSession = this.remoteSessionRepository.create({
      supportRequestId: supportRequest.id,
      deviceId: supportRequest.deviceId,
      technicianId: user.id,
      status: RemoteSessionStatus.CONNECTING,
      connectedAt: null,
      endedAt: null,
      endedBy: null,
    });

    const created = await this.save(remoteSession);

    // Las relaciones ya estan resueltas: el dispositivo viene de la solicitud y
    // el tecnico es el usuario autenticado. No hace falta releer nada.
    created.device = supportRequest.device;
    created.technician = user;

    // Primero persistir, despues avisar. Si el evento no llega porque la tablet
    // se desconecto justo despues de comprobar la presencia, la sesion sigue
    // siendo valida: la recupera con GET /device/remote-sessions/current.
    this.notifyCreated(created);

    return this.toResponse(created);
  }

  /**
   * Sesion concreta para la aplicacion del tecnico.
   *
   * Conocer el UUID no alcanza: solo la ve el tecnico al que pertenece.
   */
  async findOneForTechnician(
    id: string,
    user: User,
  ): Promise<RemoteSessionResponseDto> {
    return this.toResponse(await this.findOwnedByTechnicianOrFail(id, user.id));
  }

  /** El tecnico finaliza la asistencia. */
  async closeByTechnician(
    id: string,
    user: User,
  ): Promise<RemoteSessionResponseDto> {
    const remoteSession = await this.findOwnedByTechnicianOrFail(id, user.id);

    const closed = await this.close(
      remoteSession,
      RemoteSessionEndedBy.TECHNICIAN,
    );

    this.notifyClosed(closed);

    return this.toResponse(closed);
  }

  // ---------------------------------------------------------------------------
  // Dispositivo (Device JWT)
  // ---------------------------------------------------------------------------

  /**
   * Sesion viva del dispositivo autenticado, o `null` si no tiene.
   *
   * Es como la tablet recupera su sesion tras reconectarse, reiniciar la app o
   * perderse el evento de Socket.IO. El `deviceId` sale del Device JWT.
   */
  async findCurrentForDevice(
    deviceId: string,
  ): Promise<CurrentRemoteSessionResponseDto> {
    const remoteSession = await this.remoteSessionRepository.findOne({
      where: {
        deviceId,
        status: In([...ACTIVE_REMOTE_SESSION_STATUSES]),
      },
      relations: { device: true, technician: true },
    });

    return {
      remoteSession: remoteSession ? this.toResponse(remoteSession) : null,
    };
  }

  /**
   * El usuario de la tablet corta la sesion.
   *
   * DECISION: no se le reenvia `remote-session:closed`. Quien cierra ya recibe
   * la sesion cerrada en la respuesta HTTP, igual que ocurre con las
   * transiciones de `SupportRequest`, y el estado siempre se puede releer por
   * REST. Al tecnico tampoco se le notifica: todavia no existe Socket.IO de
   * tecnicos y la Flutter Web recupera el estado por REST.
   */
  async closeByDevice(
    id: string,
    device: Device,
  ): Promise<RemoteSessionResponseDto> {
    const remoteSession = await this.findOwnedByDeviceOrFail(id, device.id);

    return this.toResponse(
      await this.close(remoteSession, RemoteSessionEndedBy.DEVICE),
    );
  }

  // ---------------------------------------------------------------------------
  // Interno
  // ---------------------------------------------------------------------------

  /**
   * Cierra la sesion y completa su solicitud en una unica transaccion.
   *
   * No puede quedar una sesion `CLOSED` con su solicitud todavia `ACCEPTED`:
   * los dos UPDATE se confirman juntos o no se confirma ninguno.
   *
   * El cierre va condicionado al estado actual, asi que si el tecnico y el
   * dispositivo cierran a la vez solo uno hace la transicion; el segundo
   * encuentra la fila ya cerrada, recibe `409` y no toca el `endedAt` ni el
   * `endedBy` del primero.
   */
  private async close(
    remoteSession: RemoteSession,
    endedBy: RemoteSessionEndedBy,
  ): Promise<RemoteSession> {
    const endedAt = new Date();

    await this.dataSource.transaction(async (manager) => {
      const closed = await this.closeSession(
        manager,
        remoteSession.id,
        endedAt,
        endedBy,
      );

      if (!closed)
        throw new ConflictException(
          `Remote session with id ${remoteSession.id} is already closed`,
        );

      const completed = await this.completeSupportRequest(
        manager,
        remoteSession.supportRequestId,
        endedAt,
      );

      // La solicitud podria haber llegado a un estado terminal por otra via
      // (una cancelacion del usuario mientras la sesion estaba CONNECTING).
      // No se aborta el cierre por eso: la sesion tiene que poder terminar
      // igualmente y la solicitud ya no esta activa.
      if (!completed)
        this.logger.warn(
          `Support request ${remoteSession.supportRequestId} was not ACCEPTED when its remote session closed`,
        );
    });

    return Object.assign(remoteSession, {
      status: RemoteSessionStatus.CLOSED,
      endedAt,
      endedBy,
    });
  }

  /**
   * `CONNECTING | ACTIVE -> CLOSED` en un unico UPDATE condicional.
   *
   * Es lo que evita las carreras: comprobacion y escritura ocurren en la misma
   * sentencia. Devuelve `false` cuando la sesion ya estaba cerrada.
   */
  private async closeSession(
    manager: EntityManager,
    id: string,
    endedAt: Date,
    endedBy: RemoteSessionEndedBy,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(RemoteSession)
      .set({ status: RemoteSessionStatus.CLOSED, endedAt, endedBy })
      .where('id = :id', { id })
      .andWhere('status IN (:...from)', {
        from: [...ACTIVE_REMOTE_SESSION_STATUSES],
      })
      .execute();

    return result.affected === 1;
  }

  /**
   * `ACCEPTED -> COMPLETED`, tambien condicional.
   *
   * Solo escribe `status` y `closedAt`: `respondedAt`, `technicianId` y
   * `assignedAt` son historia de la solicitud y no se tocan.
   */
  private async completeSupportRequest(
    manager: EntityManager,
    id: string,
    closedAt: Date,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(SupportRequest)
      .set({ status: SupportRequestStatus.COMPLETED, closedAt })
      .where('id = :id', { id })
      .andWhere('status IN (:...from)', {
        from: [SupportRequestStatus.ACCEPTED],
      })
      .execute();

    return result.affected === 1;
  }

  /** Sesion del tecnico autenticado, o `404` como si no existiera. */
  private findOwnedByTechnicianOrFail(
    id: string,
    technicianId: string,
  ): Promise<RemoteSession> {
    return this.findOwnedOrFail(id, { technicianId });
  }

  /** Sesion del dispositivo autenticado, o `404` como si no existiera. */
  private findOwnedByDeviceOrFail(
    id: string,
    deviceId: string,
  ): Promise<RemoteSession> {
    return this.findOwnedOrFail(id, { deviceId });
  }

  /**
   * La pertenencia viaja en el WHERE.
   *
   * Una sesion ajena responde `404` igual que una inexistente: conocer un UUID
   * valido no autoriza nada y tampoco debe confirmar que la sesion existe.
   */
  private async findOwnedOrFail(
    id: string,
    owner: Partial<Pick<RemoteSession, 'technicianId' | 'deviceId'>>,
  ): Promise<RemoteSession> {
    const remoteSession = await this.remoteSessionRepository.findOne({
      where: { id, ...owner },
      relations: { device: true, technician: true },
    });

    if (!remoteSession)
      throw new NotFoundException(`Remote session with id ${id} not found`);

    return remoteSession;
  }

  /**
   * Guarda la sesion traduciendo las restricciones de PostgreSQL.
   *
   * Las dos unicidades las comprueba el motor y no un SELECT previo: dos
   * peticiones simultaneas del mismo tecnico lo pasarian las dos.
   */
  private async save(remoteSession: RemoteSession): Promise<RemoteSession> {
    try {
      return await this.remoteSessionRepository.save(remoteSession);
    } catch (error) {
      const constraint = this.uniqueViolationConstraint(error);

      if (constraint === ACTIVE_REMOTE_SESSION_INDEX)
        throw new ConflictException(
          `Device with id ${remoteSession.deviceId} already has an active remote session`,
        );

      if (constraint !== null)
        throw new ConflictException(
          `Support request with id ${remoteSession.supportRequestId} already has a remote session`,
        );

      this.logger.error(error);

      throw new InternalServerErrorException('Please check server logs');
    }
  }

  /**
   * Nombre del indice unico violado, o `null` si el error es otro.
   *
   * La tabla tiene dos unicidades distintas (una sesion por solicitud y una
   * sesion viva por dispositivo) y el mensaje no es el mismo, asi que aqui si
   * hace falta distinguirlas.
   */
  private uniqueViolationConstraint(error: unknown): string | null {
    if (!(error instanceof QueryFailedError)) return null;

    const driverError = error.driverError as unknown as PostgresError | null;

    if (driverError?.code !== UNIQUE_VIOLATION) return null;

    return driverError.constraint ?? '';
  }

  /**
   * Avisa a la tablet de que la asistencia empezo.
   *
   * Va por `DeviceRealtimeService` y no por el gateway: este servicio no conoce
   * Socket.IO. El tecnico se publica con la misma representacion que en
   * `support:assigned`.
   */
  private notifyCreated(remoteSession: RemoteSession): void {
    const payload: RemoteSessionCreatedPayload = {
      remoteSessionId: remoteSession.id,
      supportRequestId: remoteSession.supportRequestId,
      technician: SupportRequestTechnicianDto.fromTechnician(
        remoteSession.technician,
      ),
    };

    this.deviceRealtimeService.emitToDevice(
      remoteSession.deviceId,
      REMOTE_SESSION_CREATED_EVENT,
      payload,
    );
  }

  /** Avisa a la tablet de que el tecnico termino la sesion. */
  private notifyClosed(remoteSession: RemoteSession): void {
    const payload: RemoteSessionClosedPayload = {
      remoteSessionId: remoteSession.id,
      endedBy: remoteSession.endedBy ?? RemoteSessionEndedBy.SYSTEM,
    };

    this.deviceRealtimeService.emitToDevice(
      remoteSession.deviceId,
      REMOTE_SESSION_CLOSED_EVENT,
      payload,
    );
  }

  /** La presencia se resuelve al responder: `isOnline` no es una columna. */
  private toResponse(remoteSession: RemoteSession): RemoteSessionResponseDto {
    return RemoteSessionResponseDto.fromEntity(
      remoteSession,
      this.devicePresenceService.isOnline(remoteSession.deviceId),
    );
  }
}
