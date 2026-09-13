import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DEVICE_JWT_STRATEGY } from '../strategies/device-jwt.strategy';

/** Propiedad de la request donde queda el dispositivo autenticado. */
export const DEVICE_REQUEST_PROPERTY = 'device';

/**
 * Guard de la estrategia `device-jwt`.
 *
 * Deja el dispositivo autenticado en `request.device` en vez de
 * `request.user`: mezclar ambos en la misma propiedad invitaria a tratar un
 * dispositivo como si fuera un tecnico.
 */
@Injectable()
export class DeviceJwtGuard extends AuthGuard(DEVICE_JWT_STRATEGY) {
  getAuthenticateOptions() {
    return { property: DEVICE_REQUEST_PROPERTY };
  }
}
