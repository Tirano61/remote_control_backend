import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Device } from '../../entities/device.entity';
import { DeviceAuthService } from '../device-auth.service';
import { DeviceJwtPayload } from '../interfaces/device-jwt-payload.interface';

/** Nombre con el que se registra la estrategia en Passport. */
export const DEVICE_JWT_STRATEGY = 'device-jwt';

/**
 * Estrategia JWT exclusiva de dispositivos.
 *
 * Se registra con un nombre propio (`device-jwt`) y usa otro secreto, asi que
 * nunca puede validar un token de usuario ni la estrategia de usuarios uno de
 * dispositivo.
 */
@Injectable()
export class DeviceJwtStrategy extends PassportStrategy(
  Strategy,
  DEVICE_JWT_STRATEGY,
) {
  constructor(
    configService: ConfigService,
    private readonly deviceAuthService: DeviceAuthService,
  ) {
    const deviceJwtSecret = configService.get<string>('DEVICE_JWT_SECRET');

    if (!deviceJwtSecret)
      throw new Error('DEVICE_JWT_SECRET no está definido en la configuración');

    // Compartir secreto haria indistinguibles ambos tipos de token a nivel de firma.
    if (deviceJwtSecret === configService.get<string>('JWT_SECRET_KEY'))
      throw new Error('DEVICE_JWT_SECRET debe ser distinto de JWT_SECRET_KEY');

    super({
      secretOrKey: deviceJwtSecret,
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    });
  }

  /**
   * Se ejecuta con cada peticion cuando la firma es valida y el token no ha
   * vencido. Comprueba ademas que el dispositivo y su credencial sigan siendo
   * validos ahora, no solo cuando se emitio el token.
   */
  validate(payload: DeviceJwtPayload): Promise<Device> {
    return this.deviceAuthService.validateToken(payload);
  }
}
