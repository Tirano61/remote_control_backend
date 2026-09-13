import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { DeviceCredential } from '../entities/device-credential.entity';

/** Credencial recien emitida: el secreto en claro solo existe aqui. */
export interface IssuedDeviceCredential {
  credentialId: string;
  deviceSecret: string;
}

/**
 * Emision y verificacion de las credenciales permanentes del dispositivo.
 *
 * El secreto en texto plano solo viaja en la respuesta de la activacion: en la
 * base de datos queda unicamente su hash, y nunca se registra en logs.
 */
@Injectable()
export class DeviceCredentialsService {
  /** Bytes aleatorios del secreto. 32 bytes = 256 bits de entropia. */
  private static readonly SECRET_BYTES = 32;

  /**
   * Emite la credencial activa del dispositivo y revoca las anteriores.
   *
   * Recibe el `EntityManager` para poder ejecutarse dentro de la transaccion
   * que consume el enrolamiento: o se consume el codigo y se emite la nueva
   * credencial, o no ocurre ninguna de las dos cosas.
   */
  async issueCredential(
    manager: EntityManager,
    deviceId: string,
    now: Date,
  ): Promise<IssuedDeviceCredential> {
    await this.revokeActiveCredentials(manager, deviceId, now);

    const deviceSecret = this.generateSecret();

    const credential = manager.create(DeviceCredential, {
      deviceId,
      secretHash: this.hashSecret(deviceSecret),
      lastUsedAt: null,
      revokedAt: null,
    });

    const { id } = await manager.save(DeviceCredential, credential);

    return { credentialId: id, deviceSecret };
  }

  /** Deja sin efecto las credenciales vigentes del dispositivo. */
  async revokeActiveCredentials(
    manager: EntityManager,
    deviceId: string,
    now: Date,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(DeviceCredential)
      .set({ revokedAt: now })
      .where('"deviceId" = :deviceId', { deviceId })
      .andWhere('"revokedAt" IS NULL')
      .execute();
  }

  /**
   * Compara el secreto recibido con el hash almacenado.
   *
   * La comparacion es de tiempo constante para no filtrar informacion sobre el
   * hash a quien pueda medir el tiempo de respuesta.
   */
  matchesSecret(deviceSecret: string, secretHash: string): boolean {
    const provided = Buffer.from(this.hashSecret(deviceSecret), 'hex');
    const stored = Buffer.from(secretHash, 'hex');

    if (stored.length !== provided.length) return false;

    return timingSafeEqual(provided, stored);
  }

  /** Secreto criptografico de 32 bytes codificado en Base64URL. */
  private generateSecret(): string {
    return randomBytes(DeviceCredentialsService.SECRET_BYTES).toString(
      'base64url',
    );
  }

  /**
   * El secreto es aleatorio y de alta entropia, no una contrasena humana:
   * SHA-256 basta y evita el coste de bcrypt en cada login del dispositivo.
   */
  private hashSecret(deviceSecret: string): string {
    return createHash('sha256').update(deviceSecret, 'utf8').digest('hex');
  }
}
