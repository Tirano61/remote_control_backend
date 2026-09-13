import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { randomInt } from 'crypto';
import { CreateDeviceDto } from './dto/create-device.dto';
import { DeviceResponseDto } from './dto/device-response.dto';
import { UpdateDeviceDto } from './dto/update-device.dto';
import { Device } from './entities/device.entity';
import { DevicePresenceService } from './presence/device-presence.service';

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

  async update(
    id: string,
    updateDeviceDto: UpdateDeviceDto,
  ): Promise<DeviceResponseDto> {
    // preload solo aplica los campos presentes en el DTO.
    const device = await this.deviceRepository.preload({
      id,
      ...updateDeviceDto,
    });

    if (!device) throw new NotFoundException(`Device with id ${id} not found`);

    const updated = await this.save(device);

    // Un socket ya abierto no vuelve a comprobar la autorizacion por si mismo:
    // si el dispositivo queda deshabilitado hay que cerrar sus conexiones ahora
    // y no esperar a que venza su Device JWT.
    if (!updated.isActive) this.devicePresenceService.disconnectDevice(id);

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

  private async save(device: Device): Promise<Device> {
    try {
      return await this.deviceRepository.save(device);
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
