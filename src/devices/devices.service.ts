import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { randomInt } from 'crypto';
import { CreateDeviceDto } from './dto/create-device.dto';
import { DeviceResponseDto } from './dto/device-response.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { Device } from './entities/device.entity';
import { DevicePresenceService } from './presence/device-presence.service';
import { RemoteSessionsService } from '../remote-sessions/remote-sessions.service';
import {
  IdentityRevocationService,
  RevocableIdentityKind,
} from '../revocation/identity-revocation.service';

/** Forma minima del error que devuelve el driver de PostgreSQL. */
interface PostgresError {
  code?: string;
  detail?: string;
  constraint?: string;
}

/** unique_violation */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class DevicesService {
  /** Reintentos ante una colision de `publicId` al insertar. */
  private static readonly PUBLIC_ID_MAX_ATTEMPTS = 5;

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,

    private readonly devicePresenceService: DevicePresenceService,

    private readonly dataSource: DataSource,

    private readonly remoteSessionsService: RemoteSessionsService,

    private readonly identityRevocationService: IdentityRevocationService,
  ) {}

  async create(createDeviceDto: CreateDeviceDto): Promise<DeviceResponseDto> {
    for (
      let attempt = 1;
      attempt <= DevicesService.PUBLIC_ID_MAX_ATTEMPTS;
      attempt++
    ) {
      const device = this.deviceRepository.create({
        ...createDeviceDto,
        publicId: this.generatePublicId(),
      });

      try {
        return this.toResponse(await this.deviceRepository.save(device));
      } catch (error) {
        // La unicidad la garantiza Postgres; si chocamos, reintentamos con otro publicId.
        const isRetriableCollision =
          this.isPublicIdCollision(error) &&
          attempt < DevicesService.PUBLIC_ID_MAX_ATTEMPTS;

        if (!isRetriableCollision) this.handleDBError(error);
      }
    }

    throw new InternalServerErrorException(
      'Could not generate a unique public id, please retry',
    );
  }

  async findAll(): Promise<DeviceResponseDto[]> {
    const devices = await this.deviceRepository.find({
      order: { createdAt: 'DESC' },
    });

    return devices.map((device) => this.toResponse(device));
  }

  async findOne(id: string): Promise<DeviceResponseDto> {
    return this.toResponse(await this.findEntity(id));
  }

  /**
   * Dispositivo como entidad, para el resto de servicios del modulo.
   * La API administrativa usa `findOne`, que ademas resuelve la presencia.
   */
  async findEntity(id: string): Promise<Device> {
    const device = await this.deviceRepository.findOneBy({ id });

    if (!device) throw new NotFoundException(`Device with id ${id} not found`);

    return device;
  }

  /**
   * Edicion administrativa. Si el dispositivo queda inactivo, es una
   * REVOCACION y se aplica en este orden:
   *
   * 1. Transaccion: bloquea la fila del dispositivo (`FOR NO KEY UPDATE`),
   *    escribe los cambios y cierra con `endedBy: SYSTEM` sus sesiones vivas
   *    (sesion CLOSED + solicitud COMPLETED). O se confirma todo o nada.
   * 2. Commit. Desde aqui ningun handshake ni ninguna revalidacion lo da por
   *    activo, y `POST /remote-sessions` ya no puede abrirle otra sesion (espera
   *    a este lock y despues lee `isActive = false`).
   * 3. En el mismo tick, sin `await`: avisa `remote-session:closed` a los dos
   *    extremos y levanta la barrera de revocacion, que cierra todos sus sockets
   *    registrados e invalida cualquier handshake u operacion de signaling que
   *    hubiera leido el estado anterior.
   *
   * La revocacion queda CONFIRMADA cuando termina el paso 3, antes de responder
   * `200`. Ver `docs/REALTIME.md`, "Revocation".
   *
   * Desactivar un dispositivo que ya estaba inactivo repite los pasos sin
   * efecto: no hay sesiones vivas que cerrar ni sockets que barrer.
   */
  async update(
    id: string,
    updateDeviceDto: UpdateDeviceDto,
  ): Promise<DeviceResponseDto> {
    const { updated, closed } = await this.dataSource.transaction(
      async (manager) => {
        // Serializa con `RemoteSessionsService.create` (FOR SHARE sobre esta
        // fila) y con el re-enrolamiento (este mismo lock).
        const device = await manager.findOne(Device, {
          where: { id },
          lock: { mode: 'for_no_key_update' },
        });

        if (!device)
          throw new NotFoundException(`Device with id ${id} not found`);

        // `merge` solo aplica los campos presentes en el DTO, igual que
        // `preload`.
        manager.merge(Device, device, updateDeviceDto);

        const saved = await this.save(manager, device);

        const closedSessions = saved.isActive
          ? []
          : await this.remoteSessionsService.closeLiveSessionsWithin(
              manager,
              { deviceId: id },
              new Date(),
            );

        return { updated: saved, closed: closedSessions };
      },
    );

    // Un socket ya abierto no vuelve a comprobar la autorizacion por si mismo:
    // si el dispositivo queda deshabilitado hay que cerrar sus conexiones ahora
    // y no esperar a que venza su Device JWT. Primero el aviso de cierre (aun
    // llega a la tablet), despues la barrera, que la desconecta.
    if (!updated.isActive) {
      this.remoteSessionsService.announceSystemClosures(closed);
      this.identityRevocationService.revoke(RevocableIdentityKind.DEVICE, id);
    }

    return this.toResponse(updated);
  }

  /**
   * Anade a la respuesta la presencia en tiempo real.
   *
   * `isOnline` se calcula en cada lectura desde `DevicePresenceService`: es
   * estado de conexion, no una columna de la base de datos.
   */
  private toResponse(device: Device): DeviceResponseDto {
    return DeviceResponseDto.fromEntity(
      device,
      this.devicePresenceService.isOnline(device.id),
    );
  }

  private async save(manager: EntityManager, device: Device): Promise<Device> {
    try {
      return await manager.save(Device, device);
    } catch (error) {
      this.handleDBError(error);
    }
  }

  /**
   * Genera un identificador publico legible con formato `384-729-142`.
   * Solo es un identificador: no sirve como credencial del dispositivo.
   */
  private generatePublicId(): string {
    const group = () => randomInt(0, 1000).toString().padStart(3, '0');
    return `${group()}-${group()}-${group()}`;
  }

  private isPublicIdCollision(error: unknown): boolean {
    const pgError = this.getPostgresError(error);

    if (pgError?.code !== UNIQUE_VIOLATION) return false;

    return `${pgError.constraint ?? ''} ${pgError.detail ?? ''}`.includes(
      'publicId',
    );
  }

  private getPostgresError(error: unknown): PostgresError | undefined {
    if (!(error instanceof QueryFailedError)) return undefined;

    return error.driverError as unknown as PostgresError;
  }

  private handleDBError(error: unknown): never {
    const pgError = this.getPostgresError(error);

    if (pgError?.code === UNIQUE_VIOLATION)
      throw new BadRequestException(pgError.detail);

    console.log(error);

    throw new InternalServerErrorException('Please check server logs');
  }
}
