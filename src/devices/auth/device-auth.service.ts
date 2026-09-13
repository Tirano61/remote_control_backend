import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { DeviceCredential } from '../entities/device-credential.entity';
import { Device } from '../entities/device.entity';
import { DeviceCredentialsService } from './device-credentials.service';
import { DeviceLoginDto } from './dto/device-login.dto';
import {
  DEVICE_TOKEN_TYPE,
  DeviceJwtPayload,
} from './interfaces/device-jwt-payload.interface';

/** Datos del dispositivo que pueden salir por la API. Nunca la credencial. */
export interface DeviceIdentityResponse {
  id: string;
  publicId: string;
  name: string | null;
  isActive: boolean;
}

/** Respuesta del login del dispositivo. */
export interface DeviceLoginResponse extends DeviceIdentityResponse {
  token: string;
}

/**
 * Resultado de autenticar un Device JWT: el dispositivo y la credencial
 * concreta con la que se autentico.
 */
export interface AuthenticatedDevice {
  device: Device;
  credentialId: string;
}

/**
 * Autenticacion propia del dispositivo.
 *
 * Deliberadamente separada de `AuthService`: un dispositivo no es un `User`,
 * no tiene roles y firma sus tokens con otro secreto.
 */
@Injectable()
export class DeviceAuthService {
  /**
   * Hash de descarte, con el mismo formato que uno real. Se compara contra el
   * cuando no hay credencial que verificar, para que el tiempo de respuesta no
   * delate si el dispositivo existe o si esta activo.
   */
  private static readonly DECOY_HASH = createHash('sha256')
    .update('decoy', 'utf8')
    .digest('hex');

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,

    @InjectRepository(DeviceCredential)
    private readonly deviceCredentialRepository: Repository<DeviceCredential>,

    private readonly deviceCredentialsService: DeviceCredentialsService,

    private readonly jwtService: JwtService,
  ) {}

  /**
   * Canjea la credencial permanente de la tablet por un Device JWT.
   *
   * Todos los motivos de rechazo (dispositivo inexistente o inactivo,
   * credencial revocada, secreto incorrecto) devuelven el mismo error: quien
   * prueba credenciales no debe poder deducir nada de la respuesta.
   */
  async login(deviceLoginDto: DeviceLoginDto): Promise<DeviceLoginResponse> {
    const { deviceId, deviceSecret } = deviceLoginDto;

    const device = await this.deviceRepository.findOneBy({ id: deviceId });

    if (!device || !device.isActive) {
      this.burnVerificationTime(deviceSecret);
      throw new UnauthorizedException('Invalid device credentials');
    }

    const credential = await this.findActiveCredential(device.id);

    if (!credential) {
      this.burnVerificationTime(deviceSecret);
      throw new UnauthorizedException('Invalid device credentials');
    }

    const matches = this.deviceCredentialsService.matchesSecret(
      deviceSecret,
      credential.secretHash,
    );

    if (!matches) throw new UnauthorizedException('Invalid device credentials');

    await this.deviceCredentialRepository.update(
      { id: credential.id },
      { lastUsedAt: new Date() },
    );

    return {
      ...this.toIdentity(device),
      token: this.signDeviceToken(device.id, credential.id),
    };
  }

  /**
   * Comprobaciones que hace la estrategia con cada peticion del dispositivo.
   *
   * Passport ya verifico la firma y el vencimiento del token, asi que aqui solo
   * queda revalidar el estado actual.
   */
  async validateToken(payload: DeviceJwtPayload): Promise<Device> {
    const { device } = await this.authorizePayload(payload);

    return device;
  }

  /**
   * Autentica un Device JWT recibido fuera de Passport, como el del handshake
   * de Socket.IO.
   *
   * Es el mismo camino que usa la estrategia HTTP, con la verificacion de firma
   * y vencimiento por delante: asi las reglas de autorizacion del dispositivo
   * no se duplican entre transportes.
   */
  async authenticateToken(token: string): Promise<AuthenticatedDevice> {
    let payload: DeviceJwtPayload;

    try {
      // Firmado con DEVICE_JWT_SECRET: un token de usuario/tecnico no verifica.
      payload = await this.jwtService.verifyAsync<DeviceJwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Token not valid');
    }

    return this.authorizePayload(payload);
  }

  /**
   * Estado actual del dispositivo detras de un Device JWT ya verificado.
   *
   * Que el token sea criptograficamente valido no alcanza: el dispositivo puede
   * haber sido desactivado o haberse re-enrolado despues de emitirse.
   */
  private async authorizePayload(
    payload: DeviceJwtPayload,
  ): Promise<AuthenticatedDevice> {
    const { sub, tokenType, credentialId } = payload;

    if (tokenType !== DEVICE_TOKEN_TYPE)
      throw new UnauthorizedException('Token not valid');

    const device = await this.deviceRepository.findOneBy({ id: sub });

    if (!device) throw new UnauthorizedException('Token not valid');

    if (!device.isActive)
      throw new UnauthorizedException('Device is inactive, talk with an admin');

    const credential = await this.findActiveCredential(device.id);

    // Un re-enrolamiento revoca la credencial anterior y con ella sus tokens.
    if (!credential || credential.id !== credentialId)
      throw new UnauthorizedException('Token not valid');

    return { device, credentialId: credential.id };
  }

  /** Informacion minima del dispositivo autenticado. */
  checkDeviceStatus(device: Device): DeviceIdentityResponse {
    return this.toIdentity(device);
  }

  /** Credencial vigente del dispositivo, con el hash cargado explicitamente. */
  private findActiveCredential(
    deviceId: string,
  ): Promise<DeviceCredential | null> {
    return this.deviceCredentialRepository.findOne({
      where: { deviceId, revokedAt: IsNull() },
      select: { id: true, deviceId: true, secretHash: true },
    });
  }

  private signDeviceToken(deviceId: string, credentialId: string): string {
    const payload: DeviceJwtPayload = {
      sub: deviceId,
      tokenType: DEVICE_TOKEN_TYPE,
      credentialId,
    };

    return this.jwtService.sign(payload);
  }

  private toIdentity(device: Device): DeviceIdentityResponse {
    return {
      id: device.id,
      publicId: device.publicId,
      name: device.name,
      isActive: device.isActive,
    };
  }

  /** Iguala el coste de la respuesta cuando no hay nada que verificar. */
  private burnVerificationTime(deviceSecret: string): void {
    this.deviceCredentialsService.matchesSecret(
      deviceSecret,
      DeviceAuthService.DECOY_HASH,
    );
  }
}
