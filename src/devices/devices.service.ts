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
import { UpdateDeviceDto } from './dto/update-device.dto';
import { Device } from './entities/device.entity';

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
  ) {}

  async create(createDeviceDto: CreateDeviceDto): Promise<Device> {
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
        return await this.deviceRepository.save(device);
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

  findAll(): Promise<Device[]> {
    return this.deviceRepository.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Device> {
    const device = await this.deviceRepository.findOneBy({ id });

    if (!device) throw new NotFoundException(`Device with id ${id} not found`);

    return device;
  }

  async update(id: string, updateDeviceDto: UpdateDeviceDto): Promise<Device> {
    // preload solo aplica los campos presentes en el DTO.
    const device = await this.deviceRepository.preload({
      id,
      ...updateDeviceDto,
    });

    if (!device) throw new NotFoundException(`Device with id ${id} not found`);

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
