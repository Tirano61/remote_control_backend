import {
  ConflictException,
  ForbiddenException,
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
import { RemoteSession } from '../remote-sessions/entities/remote-session.entity';
import { ACTIVE_REMOTE_SESSION_STATUSES } from '../remote-sessions/enums/remote-session-status.enum';
import { QuerySupportRequestsDto } from './dto/query-support-requests.dto';
import {
  CurrentSupportRequestResponseDto,
  SupportRequestResponseDto,
  SupportRequestTechnicianDto,
} from './dto/support-request-response.dto';
import { SupportRequest } from './entities/support-request.entity';
import {
  ACTIVE_SUPPORT_REQUEST_STATUSES,
  SupportRequestStatus,
} from './enums/support-request-status.enum';

/** Aviso a la tablet de que un tecnico tomo su solicitud. */
export const SUPPORT_ASSIGNED_EVENT = 'support:assigned';

/** Payload de `support:assigned`. Sin email, sin roles y sin tokens. */
export interface SupportAssignedPayload {
  supportRequestId: string;
  technician: SupportRequestTechnicianDto;
}

/** Forma minima del error que devuelve el driver de PostgreSQL. */
interface PostgresError {
  code?: string;
}

/** unique_violation */
const UNIQUE_VIOLATION = '23505';

/** Campos que cada transicion escribe junto con el nuevo estado. */
type SupportRequestTransition = Partial<
  Pick<
    SupportRequest,
    'status' | 'technicianId' | 'assignedAt' | 'respondedAt' | 'closedAt'
  >
>;

@Injectable()
export class SupportRequestsService {
  private readonly logger = new Logger(SupportRequestsService.name);

  constructor(
    @InjectRepository(SupportRequest)
    private readonly supportRequestRepository: Repository<SupportRequest>,

    private readonly dataSource: DataSource,

    private readonly devicePresenceService: DevicePresenceService,

    private readonly deviceRealtimeService: DeviceRealtimeService,
  ) {}

  // ---------------------------------------------------------------------------
  // Dispositivo (Device JWT)
  // ---------------------------------------------------------------------------

  /**
   * Abre una solicitud de asistencia para el dispositivo autenticado.
   *
   * El dispositivo sale del Device JWT (`@GetDevice()`): el body no lleva
   * `deviceId` y no se aceptaria aunque lo llevara.
   */
  async createForDevice(device: Device): Promise<SupportRequestResponseDto> {
    // `@DeviceAuth()` ya revalida el estado del dispositivo en cada peticion;
    // se repite aqui para que la regla quede explicita en el flujo de negocio.
    if (!device.isActive)
      throw new ForbiddenException('Device is inactive, talk with an admin');

    const supportRequest = this.supportRequestRepository.create({
      deviceId: device.id,
      status: SupportRequestStatus.WAITING,
      technicianId: null,
      assignedAt: null,
      respondedAt: null,
      closedAt: null,
    });

    try {
      const created = await this.supportRequestRepository.save(supportRequest);

      return SupportRequestResponseDto.forDevice(created);
    } catch (error) {
      // La unicidad de la solicitud activa la impone el indice parcial de
      // PostgreSQL: no hay un SELECT previo que pudiera perder la carrera
      // contra otra peticion del mismo dispositivo.
      if (this.isUniqueViolation(error))
        throw new ConflictException(
          'The device already has an active support request',
        );

      this.logger.error(error);

      throw new InternalServerErrorException('Please check server logs');
    }
  }

  /** Solicitud activa del dispositivo autenticado, o `null` si no tiene. */
  async findCurrentForDevice(
    deviceId: string,
  ): Promise<CurrentSupportRequestResponseDto> {
    const supportRequest = await this.supportRequestRepository.findOne({
      where: {
        deviceId,
        status: In([...ACTIVE_SUPPORT_REQUEST_STATUSES]),
      },
      relations: { technician: true },
    });

    return {
      supportRequest: supportRequest
        ? SupportRequestResponseDto.forDevice(supportRequest)
        : null,
    };
  }

  /** `ASSIGNED -> ACCEPTED`: el usuario autoriza a ese tecnico a continuar. */
  acceptByDevice(
    id: string,
    device: Device,
  ): Promise<SupportRequestResponseDto> {
    return this.runDeviceTransition(
      id,
      device,
      [SupportRequestStatus.ASSIGNED],
      {
        status: SupportRequestStatus.ACCEPTED,
        respondedAt: new Date(),
      },
    );
  }

  /** `ASSIGNED -> REJECTED`: terminal, la solicitud queda cerrada. */
  rejectByDevice(
    id: string,
    device: Device,
  ): Promise<SupportRequestResponseDto> {
    const now = new Date();

    return this.runDeviceTransition(
      id,
      device,
      [SupportRequestStatus.ASSIGNED],
      {
        status: SupportRequestStatus.REJECTED,
        respondedAt: now,
        closedAt: now,
      },
    );
  }

  /**
   * El usuario retira su autorizacion. Terminal.
   *
   * Cancelable desde `WAITING`, `ASSIGNED` y `ACCEPTED`, pero solo mientras la
   * asistencia remota no haya empezado: una vez que existe una `RemoteSession`
   * viva la solicitud deja de poder cancelarse y el usuario tiene que cortar
   * por `POST /device/remote-sessions/:id/close`, que cierra sesion y solicitud
   * a la vez. De lo contrario podria quedar una solicitud `CANCELLED` con una
   * sesion `CONNECTING`, que es justo el estado que no debe existir.
   *
   * Toda la operacion va en una transaccion que bloquea la fila de la solicitud
   * (`FOR UPDATE`): la creacion de la sesion bloquea esa misma fila, asi que
   * cancelar y abrir sesion no pueden decidir a la vez sobre el mismo estado.
   */
  async cancelByDevice(
    id: string,
    device: Device,
  ): Promise<SupportRequestResponseDto> {
    await this.dataSource.transaction(async (manager) => {
      const supportRequest = await this.lockOwnedByDeviceOrFail(
        manager,
        id,
        device.id,
      );

      if (!ACTIVE_SUPPORT_REQUEST_STATUSES.includes(supportRequest.status))
        throw new ConflictException(
          `Support request with id ${id} cannot change from ${supportRequest.status} to ${SupportRequestStatus.CANCELLED}`,
        );

      // Solo `ACCEPTED` puede tener sesion: antes de aceptar no se crea
      // ninguna, asi que en los demas estados la consulta sobraria.
      if (
        supportRequest.status === SupportRequestStatus.ACCEPTED &&
        (await this.hasLiveRemoteSession(manager, id))
      )
        // Sin detalles internos: al usuario solo le interesa que la asistencia
        // ya empezo y por donde tiene que terminarla.
        throw new ConflictException(
          `Remote assistance for support request with id ${id} already started, close the remote session instead`,
        );

      const cancelled = await this.applyTransition(
        manager,
        id,
        ACTIVE_SUPPORT_REQUEST_STATUSES,
        {
          status: SupportRequestStatus.CANCELLED,
          closedAt: new Date(),
        },
      );

      // Con la fila bloqueada nadie ha podido moverla desde la comprobacion de
      // arriba; queda como red de seguridad del UPDATE condicional.
      if (!cancelled)
        throw new ConflictException(
          `Support request with id ${id} cannot change from ${supportRequest.status} to ${SupportRequestStatus.CANCELLED}`,
        );
    });

    return SupportRequestResponseDto.forDevice(await this.findByIdOrFail(id));
  }

  // ---------------------------------------------------------------------------
  // Tecnicos / admin (JWT de usuario)
  // ---------------------------------------------------------------------------

  /** Listado para la aplicacion del tecnico, las mas antiguas primero. */
  async findAll(
    query: QuerySupportRequestsDto,
  ): Promise<SupportRequestResponseDto[]> {
    const supportRequests = await this.supportRequestRepository.find({
      where: query.status ? { status: query.status } : {},
      relations: { device: true, technician: true },
      order: { createdAt: 'ASC' },
    });

    return supportRequests.map((supportRequest) =>
      this.toTechnicianResponse(supportRequest),
    );
  }

  async findOne(id: string): Promise<SupportRequestResponseDto> {
    return this.toTechnicianResponse(await this.findByIdOrFail(id));
  }

  /**
   * Un tecnico toma una solicitud en espera.
   *
   * El tecnico es el usuario autenticado: `technicianId` nunca se acepta desde
   * el cliente.
   */
  async assign(
    id: string,
    technician: User,
  ): Promise<SupportRequestResponseDto> {
    const supportRequest = await this.findByIdOrFail(id);

    if (supportRequest.status !== SupportRequestStatus.WAITING)
      throw new ConflictException(
        `Support request with id ${id} is not waiting to be assigned`,
      );

    // Una tablet desconectada no puede recibir el aviso ni responder, asi que
    // no se le asigna tecnico. La solicitud sigue WAITING: nada se cancela
    // automaticamente porque el dispositivo puede reconectarse.
    if (!this.devicePresenceService.isOnline(supportRequest.deviceId))
      throw new ConflictException(
        `Device with id ${supportRequest.deviceId} is offline`,
      );

    const assigned = await this.applyTransition(
      this.dataSource.manager,
      id,
      [SupportRequestStatus.WAITING],
      {
        status: SupportRequestStatus.ASSIGNED,
        technicianId: technician.id,
        assignedAt: new Date(),
      },
    );

    // Dos tecnicos pueden haber pulsado ATENDER a la vez: decide el UPDATE
    // condicional, y el segundo no sobreescribe al primero.
    if (!assigned)
      throw new ConflictException(
        `Support request with id ${id} was already taken by another technician`,
      );

    const updated = await this.findByIdOrFail(id);

    this.notifyAssigned(updated, technician);

    return this.toTechnicianResponse(updated);
  }

  // ---------------------------------------------------------------------------
  // Interno
  // ---------------------------------------------------------------------------

  /**
   * Transicion pedida por el dispositivo: comprueba la pertenencia y aplica el
   * cambio solo desde los estados permitidos.
   */
  private async runDeviceTransition(
    id: string,
    device: Device,
    from: readonly SupportRequestStatus[],
    changes: SupportRequestTransition,
  ): Promise<SupportRequestResponseDto> {
    const supportRequest = await this.findOwnedByDeviceOrFail(id, device.id);

    const applied = await this.applyTransition(
      this.dataSource.manager,
      id,
      from,
      changes,
    );

    if (!applied)
      throw new ConflictException(
        `Support request with id ${id} cannot change from ${supportRequest.status} to ${changes.status}`,
      );

    return SupportRequestResponseDto.forDevice(await this.findByIdOrFail(id));
  }

  /**
   * Bloquea la fila de la solicitud del dispositivo autenticado.
   *
   * Es el `SELECT ... FOR UPDATE` que serializa esta transaccion con la
   * creacion de la sesion remota, que bloquea la misma fila. La pertenencia
   * viaja en el WHERE, igual que en `findOwnedByDeviceOrFail`: una solicitud
   * ajena responde `404` y ni siquiera se bloquea.
   *
   * No se piden relaciones a proposito: TypeORM las resolveria con LEFT JOIN y
   * PostgreSQL no admite `FOR UPDATE` sobre el lado nullable de un outer join.
   */
  private async lockOwnedByDeviceOrFail(
    manager: EntityManager,
    id: string,
    deviceId: string,
  ): Promise<SupportRequest> {
    const supportRequest = await manager.findOne(SupportRequest, {
      where: { id, deviceId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!supportRequest)
      throw new NotFoundException(`Support request with id ${id} not found`);

    return supportRequest;
  }

  /**
   * Hay una sesion remota viva nacida de esta solicitud.
   *
   * DECISION: se consulta `RemoteSession` con el `EntityManager` de la
   * transaccion en lugar de inyectar su repositorio o el `RemoteSessionsService`.
   * Un repositorio inyectado ejecutaria la consulta en otra conexion, fuera de
   * la transaccion que sostiene el lock, que es justo lo que hay que evitar; y
   * depender del otro servicio acoplaria los dos dominios. `SupportRequestsModule`
   * no importa `RemoteSessionsModule`: solo se usa la entidad, que ya esta
   * registrada en el `DataSource`.
   */
  private hasLiveRemoteSession(
    manager: EntityManager,
    supportRequestId: string,
  ): Promise<boolean> {
    return manager.exists(RemoteSession, {
      where: {
        supportRequestId,
        status: In([...ACTIVE_REMOTE_SESSION_STATUSES]),
      },
    });
  }

  /**
   * Cambio de estado condicionado al estado actual, en un unico UPDATE.
   *
   * Comprobacion y escritura ocurren en la misma sentencia, asi que dos
   * peticiones simultaneas no pueden aplicar ambas la transicion. Devuelve
   * `false` cuando otra llego antes.
   *
   * Recibe el `EntityManager` para poder ejecutarse dentro de la transaccion de
   * la cancelacion; el resto de transiciones pasan el manager del `DataSource`,
   * que es el comportamiento de siempre.
   */
  private async applyTransition(
    manager: EntityManager,
    id: string,
    from: readonly SupportRequestStatus[],
    changes: SupportRequestTransition,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(SupportRequest)
      .set(changes)
      .where('id = :id', { id })
      .andWhere('status IN (:...from)', { from: [...from] })
      .execute();

    return result.affected === 1;
  }

  private async findByIdOrFail(id: string): Promise<SupportRequest> {
    const supportRequest = await this.supportRequestRepository.findOne({
      where: { id },
      relations: { device: true, technician: true },
    });

    if (!supportRequest)
      throw new NotFoundException(`Support request with id ${id} not found`);

    return supportRequest;
  }

  /**
   * Solicitud del dispositivo autenticado.
   *
   * Conocer un UUID valido no autoriza nada: si la solicitud pertenece a otro
   * dispositivo se responde `404`, igual que si no existiera, para no
   * confirmarle la existencia de solicitudes ajenas.
   */
  private async findOwnedByDeviceOrFail(
    id: string,
    deviceId: string,
  ): Promise<SupportRequest> {
    const supportRequest = await this.supportRequestRepository.findOne({
      where: { id, deviceId },
    });

    if (!supportRequest)
      throw new NotFoundException(`Support request with id ${id} not found`);

    return supportRequest;
  }

  /**
   * Avisa a la tablet de que un tecnico tomo su solicitud.
   *
   * Va por `DeviceRealtimeService`, no por el gateway: este servicio no conoce
   * Socket.IO. Si el aviso no llega (la tablet se desconecto justo despues de
   * comprobar la presencia) la asignacion sigue siendo valida: el estado esta
   * en PostgreSQL y el dispositivo lo recupera con
   * `GET /support-requests/current` al reconectarse.
   */
  private notifyAssigned(
    supportRequest: SupportRequest,
    technician: User,
  ): void {
    const payload: SupportAssignedPayload = {
      supportRequestId: supportRequest.id,
      technician: { id: technician.id, name: technician.fullName },
    };

    this.deviceRealtimeService.emitToDevice(
      supportRequest.deviceId,
      SUPPORT_ASSIGNED_EVENT,
      payload,
    );
  }

  private toTechnicianResponse(
    supportRequest: SupportRequest,
  ): SupportRequestResponseDto {
    return SupportRequestResponseDto.forTechnician(
      supportRequest,
      this.devicePresenceService.isOnline(supportRequest.deviceId),
    );
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;

    // La unica restriccion unica de la tabla es la de solicitud activa por
    // dispositivo, asi que no hace falta distinguir por nombre de indice.
    const driverError = error.driverError as unknown as PostgresError | null;

    return driverError?.code === UNIQUE_VIOLATION;
  }
}
