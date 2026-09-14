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
import { TechnicianRealtimeService } from '../signaling/realtime/technician-realtime.service';
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
  ACTIVE_TECHNICIAN_REMOTE_SESSION_INDEX,
  REMOTE_SESSION_SUPPORT_REQUEST_INDEX,
  RemoteSession,
} from './entities/remote-session.entity';
import { RemoteSessionEndedBy } from './enums/remote-session-ended-by.enum';
import {
  ACTIVE_REMOTE_SESSION_STATUSES,
  RemoteSessionStatus,
} from './enums/remote-session-status.enum';

/** Aviso a la tablet de que el tecnico inicio la asistencia. */
export const REMOTE_SESSION_CREATED_EVENT = 'remote-session:created';

/**
 * Aviso de que la sesion termino, hacia el extremo que NO la cerro.
 *
 * Mismo nombre y mismo payload en los dos namespaces: `/devices` cuando cierra
 * el tecnico y `/technicians` cuando cierra el dispositivo. Un unico contrato
 * para un unico hecho.
 */
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

    // `SupportRequest` ya no se inyecta: todas sus lecturas y escrituras van
    // por el `EntityManager` de la transaccion, que es lo unico que sostiene el
    // lock. Un repositorio inyectado consultaria por otra conexion, fuera de
    // ella.
    private readonly dataSource: DataSource,

    private readonly devicePresenceService: DevicePresenceService,

    private readonly deviceRealtimeService: DeviceRealtimeService,

    private readonly technicianRealtimeService: TechnicianRealtimeService,
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
   *
   * Un tecnico atiende como maximo una sesion viva: si ya tiene una
   * `CONNECTING` o `ACTIVE`, la segunda responde `409` aunque sea sobre otro
   * dispositivo. Al cerrarla queda habilitado de inmediato, sin ninguna
   * limpieza: el indice unico parcial deja fuera las filas `CLOSED`.
   */
  async create(
    createRemoteSessionDto: CreateRemoteSessionDto,
    user: User,
  ): Promise<RemoteSessionResponseDto> {
    const { supportRequestId } = createRemoteSessionDto;

    // Todo va en una transaccion que bloquea la fila de la solicitud: es el
    // punto de serializacion con `SupportRequestsService.cancelByDevice`, que
    // bloquea esa misma fila. Sin el lock, un SELECT previo podria ver
    // `ACCEPTED` y crear la sesion justo mientras la tablet cancela, dejando
    // una solicitud CANCELLED con una sesion CONNECTING.
    const created = await this.dataSource.transaction(async (manager) => {
      const supportRequest = await this.lockOwnedByTechnicianOrFail(
        manager,
        supportRequestId,
        user.id,
      );

      // Solo una solicitud aceptada autoriza el control remoto: el usuario de
      // la tablet tuvo que autorizar expresamente a ese tecnico. Si la
      // cancelacion gano el lock, aqui ya se lee `CANCELLED`.
      if (supportRequest.status !== SupportRequestStatus.ACCEPTED)
        throw new ConflictException(
          `Support request with id ${supportRequestId} was not accepted by the device`,
        );

      // Un tecnico atiende una sola sesion a la vez, aunque la segunda fuera
      // sobre otro dispositivo. Se comprueba antes que la presencia a
      // proposito: que el tecnico ya este ocupado es un dato suyo y accionable
      // ("cierra la que tienes abierta"), mientras que una tablet offline no le
      // dice nada mientras no pueda abrir ninguna sesion.
      //
      // Esto NO es lo que garantiza la invariante: entre este SELECT y el
      // INSERT hay una carrera, y quien la cierra es el indice unico parcial.
      // Sirve para no llegar al motor en el caso normal y para dar un mensaje
      // preciso.
      if (await this.technicianHasLiveSession(manager, user.id))
        throw new ConflictException(
          `Technician with id ${user.id} already has an active remote session`,
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

      const session = await this.save(manager, remoteSession);

      // El tecnico es el usuario autenticado; el dispositivo se lee aparte
      // porque la consulta bloqueante no puede arrastrar relaciones.
      session.device = await manager.findOneByOrFail(Device, {
        id: supportRequest.deviceId,
      });
      session.technician = user;

      return session;
    });

    // Primero confirmar la transaccion, despues avisar: no se anuncia una
    // sesion que todavia pudiera no existir. Si el evento no llega porque la
    // tablet se desconecto justo despues de comprobar la presencia, la sesion
    // sigue siendo valida: la recupera con GET /device/remote-sessions/current.
    this.notifyCreated(created);

    return this.toResponse(created);
  }

  /**
   * Sesion viva del tecnico autenticado, o `null` si no tiene ninguna.
   *
   * Es como `remote_control_web` recupera su sesion tras un F5, al reabrir la
   * aplicacion o despues de perderse un evento de Socket.IO: el cliente no
   * tiene que tratar un `remoteSessionId` guardado en local como fuente de
   * verdad.
   *
   * La pertenencia viaja en el WHERE y sale exclusivamente del token: no hay
   * ningun `technicianId` que pueda llegar por query, body o path. Un `admin`
   * recupera sus propias sesiones y nada mas: aqui tampoco hay supervision ni
   * takeover.
   *
   * No hay ambiguedad que resolver: un tecnico tiene como maximo una sesion
   * viva, y lo garantiza el indice unico parcial por `technicianId`, no esta
   * consulta. El `ORDER BY createdAt DESC` se conserva porque es inocuo y deja
   * la respuesta definida incluso si algun dia se relajara la invariante.
   */
  async findCurrentForTechnician(
    technicianId: string,
  ): Promise<CurrentRemoteSessionResponseDto> {
    const remoteSession = await this.remoteSessionRepository.findOne({
      where: {
        technicianId,
        status: In([...ACTIVE_REMOTE_SESSION_STATUSES]),
      },
      relations: { device: true, technician: true },
      order: { createdAt: 'DESC' },
    });

    return {
      remoteSession: remoteSession ? this.toResponse(remoteSession) : null,
    };
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

    this.notifyDeviceClosed(closed);

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
   * DECISION: a quien cierra no se le reenvia `remote-session:closed`. Ya
   * recibe la sesion cerrada en la respuesta HTTP, igual que ocurre con las
   * transiciones de `SupportRequest`.
   *
   * Al tecnico si se le avisa, y despues del commit: es el unico extremo que se
   * quedaria mostrando una sesion que ya no existe. El aviso es simetrico del
   * que recibe la tablet cuando cierra el tecnico.
   */
  async closeByDevice(
    id: string,
    device: Device,
  ): Promise<RemoteSessionResponseDto> {
    const remoteSession = await this.findOwnedByDeviceOrFail(id, device.id);

    const closed = await this.close(remoteSession, RemoteSessionEndedBy.DEVICE);

    // Nunca antes de que la transaccion confirme: no se anuncia un cierre que
    // todavia pudiera deshacerse. Si la sesion ya estaba cerrada, `close` ha
    // lanzado `409` y aqui no se llega, asi que no se emiten avisos falsos.
    this.notifyTechnicianClosed(closed);

    return this.toResponse(closed);
  }

  // ---------------------------------------------------------------------------
  // Interno
  // ---------------------------------------------------------------------------

  /**
   * Cierra la sesion y completa su solicitud en una unica transaccion.
   *
   * Los dos UPDATE se confirman juntos o no se confirma ninguno: no puede
   * quedar una sesion `CLOSED` con su solicitud todavia `ACCEPTED`, ni una
   * sesion cerrada cuya solicitud no haya podido pasar a `COMPLETED`.
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

      // Una sesion viva implica una solicitud `ACCEPTED`: mientras exista la
      // sesion, `cancelByDevice` no puede cerrarla. Que el UPDATE no afecte a
      // exactamente una fila significa que el estado ya es inconsistente, asi
      // que se aborta y se deshace tambien el cierre de la sesion. Antes solo
      // se dejaba un `warn` y la sesion quedaba CLOSED sobre una solicitud que
      // nunca llegaba a COMPLETED.
      if (!completed)
        throw new ConflictException(
          `Support request with id ${remoteSession.supportRequestId} is not in a state that can complete the remote session`,
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
   * Bloquea la fila de la solicitud del tecnico autenticado.
   *
   * Es el `SELECT ... FOR UPDATE` que serializa la creacion con la cancelacion
   * desde la tablet, que bloquea esa misma fila. La pertenencia viaja en el
   * WHERE y no en un `if` posterior: la solicitud de otro tecnico se comporta
   * como inexistente y ni siquiera se bloquea.
   *
   * No se piden relaciones a proposito: TypeORM las resolveria con LEFT JOIN y
   * PostgreSQL no admite `FOR UPDATE` sobre el lado nullable de un outer join.
   */
  private async lockOwnedByTechnicianOrFail(
    manager: EntityManager,
    id: string,
    technicianId: string,
  ): Promise<SupportRequest> {
    const supportRequest = await manager.findOne(SupportRequest, {
      where: { id, technicianId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!supportRequest)
      throw new NotFoundException(`Support request with id ${id} not found`);

    return supportRequest;
  }

  /**
   * Guarda la sesion traduciendo las restricciones de PostgreSQL.
   *
   * Las tres unicidades las comprueba el motor y no un SELECT previo: siguen
   * siendo la segunda linea de defensa aunque ahora la solicitud este
   * bloqueada, porque el lock ordena a los que compiten por esa fila y no a
   * cualquier otro camino que pudiera abrir una sesion sobre el dispositivo o
   * sobre el tecnico. Dos peticiones simultaneas del mismo tecnico sobre
   * dispositivos distintos ni siquiera compiten por la misma solicitud: ahi el
   * indice es lo unico que decide.
   *
   * Va por el `EntityManager` de la transaccion: si la unicidad falla, el
   * `ConflictException` la aborta y no queda nada a medias.
   */
  private async save(
    manager: EntityManager,
    remoteSession: RemoteSession,
  ): Promise<RemoteSession> {
    try {
      return await manager.save(RemoteSession, remoteSession);
    } catch (error) {
      const conflict = this.uniqueViolationMessage(error, remoteSession);

      if (conflict) throw new ConflictException(conflict);

      this.logger.error(error);

      throw new InternalServerErrorException('Please check server logs');
    }
  }

  /**
   * Mensaje del conflicto que corresponde al indice unico violado, o `null` si
   * el error no es una violacion de uno de los indices de esta tabla.
   *
   * La tabla tiene tres unicidades distintas (una sesion por solicitud, una
   * sesion viva por dispositivo y una sesion viva por tecnico) y el mensaje no
   * es el mismo, asi que hay que distinguirlas por el NOMBRE de la restriccion
   * que devuelve PostgreSQL.
   *
   * Un `23505` que no sea uno de esos tres nombres NO se convierte en `409`:
   * seria un fallo distinto (la clave primaria, un indice de otra tabla, algo
   * que todavia no existe) y anunciarlo como "ya hay una sesion" mentiria al
   * cliente. Cae al `500` con el error registrado, que es lo que corresponde a
   * algo que no sabemos interpretar.
   */
  private uniqueViolationMessage(
    error: unknown,
    remoteSession: RemoteSession,
  ): string | null {
    if (!(error instanceof QueryFailedError)) return null;

    const driverError = error.driverError as unknown as PostgresError | null;

    if (driverError?.code !== UNIQUE_VIOLATION) return null;

    switch (driverError.constraint) {
      case ACTIVE_REMOTE_SESSION_INDEX:
        return `Device with id ${remoteSession.deviceId} already has an active remote session`;

      case ACTIVE_TECHNICIAN_REMOTE_SESSION_INDEX:
        return `Technician with id ${remoteSession.technicianId} already has an active remote session`;

      case REMOTE_SESSION_SUPPORT_REQUEST_INDEX:
        return `Support request with id ${remoteSession.supportRequestId} already has a remote session`;

      default:
        return null;
    }
  }

  /**
   * Si el tecnico ya tiene una sesion `CONNECTING` o `ACTIVE`.
   *
   * Va por el `EntityManager` de la transaccion y no por el repositorio
   * inyectado: tiene que leer dentro de la misma transaccion que despues
   * inserta.
   */
  private technicianHasLiveSession(
    manager: EntityManager,
    technicianId: string,
  ): Promise<boolean> {
    return manager.exists(RemoteSession, {
      where: {
        technicianId,
        status: In([...ACTIVE_REMOTE_SESSION_STATUSES]),
      },
    });
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
  private notifyDeviceClosed(remoteSession: RemoteSession): void {
    this.deviceRealtimeService.emitToDevice(
      remoteSession.deviceId,
      REMOTE_SESSION_CLOSED_EVENT,
      this.closedPayload(remoteSession),
    );
  }

  /**
   * Avisa al tecnico de que el usuario de la tablet termino la sesion.
   *
   * Va a su room personal y no a la de la sesion: `remote-session:closed` es un
   * evento de dominio, no signaling, y tiene que llegarle aunque nunca haya
   * ejecutado `remote-session:join`.
   *
   * El aviso NO es la fuente de verdad ni forma parte de la transaccion: si el
   * transporte falla, la sesion sigue `CLOSED` y su solicitud `COMPLETED`, y no
   * se deshace nada. Por eso el error se registra y no se propaga: quien cerro
   * ya recibio su respuesta HTTP correcta y convertirla en un `500` haria creer
   * que el cierre fallo. El tecnico recupera el estado con
   * `GET /remote-sessions/current`.
   */
  private notifyTechnicianClosed(remoteSession: RemoteSession): void {
    try {
      this.technicianRealtimeService.emitToTechnician(
        remoteSession.technicianId,
        REMOTE_SESSION_CLOSED_EVENT,
        this.closedPayload(remoteSession),
      );
    } catch (error) {
      // Sin datos de la sesion mas alla de su id: nada de tokens ni de SDP.
      this.logger.error(
        `Remote session ${remoteSession.id} is closed, but ${REMOTE_SESSION_CLOSED_EVENT} could not be delivered to its technician`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /** Un unico payload de cierre para los dos destinatarios. */
  private closedPayload(
    remoteSession: RemoteSession,
  ): RemoteSessionClosedPayload {
    return {
      remoteSessionId: remoteSession.id,
      endedBy: remoteSession.endedBy ?? RemoteSessionEndedBy.SYSTEM,
    };
  }

  /** La presencia se resuelve al responder: `isOnline` no es una columna. */
  private toResponse(remoteSession: RemoteSession): RemoteSessionResponseDto {
    return RemoteSessionResponseDto.fromEntity(
      remoteSession,
      this.devicePresenceService.isOnline(remoteSession.deviceId),
    );
  }
}
