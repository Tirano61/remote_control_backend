import { applyDecorators, UseGuards } from '@nestjs/common';
import { DeviceJwtGuard } from '../guards/device-jwt.guard';

/**
 * Unico decorador para proteger rutas de dispositivos.
 *
 * `@DeviceAuth()` exige un Device JWT valido y un dispositivo activo con su
 * credencial vigente. No acepta tokens de usuario y no maneja roles: los
 * dispositivos no los tienen.
 *
 * Es intencionadamente distinto de `@Auth()`, que protege rutas de
 * usuarios/tecnicos.
 */
export function DeviceAuth() {
  return applyDecorators(UseGuards(DeviceJwtGuard));
}
