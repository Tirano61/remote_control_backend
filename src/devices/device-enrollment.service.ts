import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { ActivateDeviceDto } from './dto/activate-device.dto';
import { DevicesService } from './devices.service';
import { Device } from './entities/device.entity';
import { DeviceEnrollment } from './entities/device-enrollment.entity';
import { DeviceCredentialsService } from './auth/device-credentials.service';

/** Respuesta del endpoint administrativo: el codigo viaja una unica vez. */
export interface EnrollmentCodeResponse {
  deviceId: string;
  publicId: string;
  enrollmentCode: string;
  expiresAt: Date;
}

/**
 * Respuesta de la tablet al activarse.
 *
 * `deviceSecret` viaja aqui y solo aqui: es la unica vez que el backend puede
 * entregarlo. Si se pierde, hay que volver a enrolar el dispositivo.
 */
export interface DeviceActivationResponse {
  activated: true;
  deviceId: string;
  publicId: string;
  name: string | null;
  deviceSecret: string;
}

/** Campos tecnicos que la tablet puede refrescar al activarse. */
type DeviceTechnicalInfo = Partial<
  Pick<Device, 'manufacturer' | 'model' | 'androidVersion' | 'appVersion'>
>;

@Injectable()
export class DeviceEnrollmentService {
  /** Vigencia por defecto del codigo de activacion. */
  private static readonly CODE_TTL_MINUTES = 30;

  private static readonly BCRYPT_ROUNDS = 10;

  /** Intentos fallidos tolerados antes de invalidar el codigo. */
  private static readonly MAX_FAILED_ATTEMPTS = 5;

  /**
   * Hash de descarte. Se compara contra el cuando no hay enrolamiento
   * pendiente, para que el tiempo de respuesta no delate si el `publicId`
   * existe o si el dispositivo esta activo.
   *
   * Se calcula una sola vez, la primera vez que hace falta: con bcrypt
   * asincrono ya no puede resolverse al cargar la clase.
   */
  private decoyHash: Promise<string> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly devicesService: DevicesService,
    private readonly deviceCredentialsService: DeviceCredentialsService,
  ) {}

  /**
   * Genera un nuevo codigo de activacion para un dispositivo existente.
   *
   * Invalida los codigos pendientes anteriores: solo el ultimo codigo
   * entregado al tecnico puede usarse. El codigo en texto plano se devuelve
   * una sola vez y nunca se persiste ni se registra en logs.
   */
  async createEnrollmentCode(
    deviceId: string,
  ): Promise<EnrollmentCodeResponse> {
    const device = await this.devicesService.findOne(deviceId);

    if (!device.isActive)
      throw new BadRequestException(
        `Device with id ${deviceId} is not active and cannot be enrolled`,
      );

    const code = this.generateCode();
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + DeviceEnrollmentService.CODE_TTL_MINUTES * 60_000,
    );

    // Fuera de la transaccion: bcrypt tarda y no hay que retener la conexion.
    const codeHash = await bcrypt.hash(
      code,
      DeviceEnrollmentService.BCRYPT_ROUNDS,
    );

    await this.dataSource.transaction(async (manager) => {
      await this.revokePendingEnrollments(manager, device.id, now);

      const enrollment = manager.create(DeviceEnrollment, {
        deviceId: device.id,
        codeHash,
        expiresAt,
        usedAt: null,
        revokedAt: null,
      });

      await manager.save(DeviceEnrollment, enrollment);
    });

    return {
      deviceId: device.id,
      publicId: device.publicId,
      enrollmentCode: code,
      expiresAt,
    };
  }

  /**
   * Consume un codigo de activacion enviado por la tablet.
   *
   * Cualquier motivo de rechazo (publicId inexistente, dispositivo inactivo,
   * codigo incorrecto, vencido o ya usado) devuelve el mismo error generico
   * para no dar informacion util a quien pruebe codigos al azar.
   */
  async activate(
    activateDeviceDto: ActivateDeviceDto,
  ): Promise<DeviceActivationResponse> {
    // La transaccion devuelve `null` en lugar de lanzar, para que el conteo de
    // intentos fallidos se confirme en vez de perderse en el rollback.
    const activation = await this.dataSource.transaction((manager) =>
      this.runActivation(manager, activateDeviceDto),
    );

    if (!activation) throw new UnauthorizedException('Invalid activation');

    return activation;
  }

  private async runActivation(
    manager: EntityManager,
    activateDeviceDto: ActivateDeviceDto,
  ): Promise<DeviceActivationResponse | null> {
    const { publicId, code } = activateDeviceDto;
    const now = new Date();

    const device = await manager.findOne(Device, { where: { publicId } });

    // El publicId es un identificador, no una credencial: conocerlo no alcanza.
    if (!device || !device.isActive) {
      await this.burnVerificationTime(code);
      return null;
    }

    const pending = await this.findPendingEnrollments(manager, device.id, now);

    if (pending.length === 0) {
      await this.burnVerificationTime(code);
      return null;
    }

    let enrollment: DeviceEnrollment | undefined;

    for (const candidate of pending) {
      if (await bcrypt.compare(code, candidate.codeHash)) {
        enrollment = candidate;
        break;
      }
    }

    if (!enrollment) {
      await this.registerFailedAttempts(manager, pending, now);
      return null;
    }

    // Segunda barrera ante concurrencia: solo la primera solicitud que marque
    // el codigo como usado puede continuar.
    const consumed = await manager
      .createQueryBuilder()
      .update(DeviceEnrollment)
      .set({ usedAt: now })
      .where('id = :id', { id: enrollment.id })
      .andWhere('"usedAt" IS NULL')
      .execute();

    if (consumed.affected !== 1) return null;

    const technicalInfo = this.buildTechnicalInfo(activateDeviceDto);

    if (Object.keys(technicalInfo).length > 0)
      await manager.update(Device, { id: device.id }, technicalInfo);

    // Misma transaccion que consume el codigo: la credencial anterior queda
    // revocada y la nueva emitida, o no ocurre ninguna de las dos cosas.
    const { deviceSecret } =
      await this.deviceCredentialsService.issueCredential(
        manager,
        device.id,
        now,
      );

    return {
      activated: true,
      deviceId: device.id,
      publicId: device.publicId,
      name: device.name,
      deviceSecret,
    };
  }

  /**
   * Enrolamientos todavia utilizables de un dispositivo.
   *
   * El bloqueo `FOR UPDATE` serializa las activaciones concurrentes del mismo
   * dispositivo: la segunda solicitud espera y vuelve a evaluar el filtro, por
   * lo que ya no encuentra el codigo como pendiente.
   */
  private findPendingEnrollments(
    manager: EntityManager,
    deviceId: string,
    now: Date,
  ): Promise<DeviceEnrollment[]> {
    return manager
      .createQueryBuilder(DeviceEnrollment, 'enrollment')
      .setLock('pessimistic_write')
      .addSelect('enrollment.codeHash')
      .where('enrollment.deviceId = :deviceId', { deviceId })
      .andWhere('enrollment.usedAt IS NULL')
      .andWhere('enrollment.revokedAt IS NULL')
      .andWhere('enrollment.expiresAt > :now', { now })
      .orderBy('enrollment.createdAt', 'DESC')
      .getMany();
  }

  private async revokePendingEnrollments(
    manager: EntityManager,
    deviceId: string,
    now: Date,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(DeviceEnrollment)
      .set({ revokedAt: now })
      .where('"deviceId" = :deviceId', { deviceId })
      .andWhere('"usedAt" IS NULL')
      .andWhere('"revokedAt" IS NULL')
      .execute();
  }

  /**
   * Limita los intentos por codigo: al agotarlos el codigo se invalida y el
   * tecnico debe generar uno nuevo.
   *
   * Pendiente: un rate limiting por IP/dispositivo requiere infraestructura
   * adicional (throttler compartido o Redis) y queda fuera de este paso.
   */
  private async registerFailedAttempts(
    manager: EntityManager,
    pending: DeviceEnrollment[],
    now: Date,
  ): Promise<void> {
    for (const enrollment of pending) {
      const failedAttempts = enrollment.failedAttempts + 1;
      const exhausted =
        failedAttempts >= DeviceEnrollmentService.MAX_FAILED_ATTEMPTS;

      await manager.update(
        DeviceEnrollment,
        { id: enrollment.id },
        exhausted ? { failedAttempts, revokedAt: now } : { failedAttempts },
      );
    }
  }

  private buildTechnicalInfo(
    activateDeviceDto: ActivateDeviceDto,
  ): DeviceTechnicalInfo {
    const { manufacturer, model, androidVersion, appVersion } =
      activateDeviceDto;
    const technicalInfo: DeviceTechnicalInfo = {};

    if (manufacturer !== undefined) technicalInfo.manufacturer = manufacturer;
    if (model !== undefined) technicalInfo.model = model;
    if (androidVersion !== undefined)
      technicalInfo.androidVersion = androidVersion;
    if (appVersion !== undefined) technicalInfo.appVersion = appVersion;

    return technicalInfo;
  }

  /** Codigo numerico de 6 digitos generado con el CSPRNG del sistema. */
  private generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /** Iguala el costo de la respuesta cuando no hay nada que verificar. */
  private async burnVerificationTime(code: string): Promise<void> {
    this.decoyHash ??= bcrypt.hash(
      '000000',
      DeviceEnrollmentService.BCRYPT_ROUNDS,
    );

    await bcrypt.compare(code, await this.decoyHash);
  }
}
