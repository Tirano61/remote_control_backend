import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError, Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { Device } from '../devices/entities/device.entity';
import { DevicePresenceService } from '../devices/presence/device-presence.service';
import { DeviceRealtimeService } from '../devices/realtime/device-realtime.service';
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

  /** Cancelacion por el usuario desde cualquier estado activo. Terminal. */
  cancelByDevice(
    id: string,
    device: Device,
  ): Promise<SupportRequestResponseDto> {
    return this.runDeviceTransition(
      id,
      device,
      ACTIVE_SUPPORT_REQUEST_STATUSES,
      {
        status: SupportRequestStatus.CANCELLED,
        closedAt: new Date(),
      },
    );
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

    const applied = await this.applyTransition(id, from, changes);

    if (!applied)
      throw new ConflictException(
        `Support request with id ${id} cannot change from ${supportRequest.status} to ${changes.status}`,
      );

    return SupportRequestResponseDto.forDevice(await this.findByIdOrFail(id));
  }

  /**
   * Cambio de estado condicionado al estado actual, en un unico UPDATE.
   *
   * Es lo que evita las carreras: comprobacion y escritura ocurren en la misma
   * sentencia, asi que dos peticiones simultaneas no pueden aplicar ambas la
   * transicion. Devuelve `false` cuando otra llego antes.
   */
  private async applyTransition(
    id: string,
    from: readonly SupportRequestStatus[],
    changes: SupportRequestTransition,
  ): Promise<boolean> {
    const result = await this.supportRequestRepository
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
