import { HttpStatus, UnauthorizedException } from '@nestjs/common';

/**
 * Codigo de aplicacion de `POST /device-auth/login` cuando el backend ha
 * comprobado que la credencial presentada no vale: dispositivo inexistente o
 * inactivo, credencial revocada (re-enrolamiento) o secreto incorrecto.
 *
 * Es una senal de aplicacion para que el cliente distinga "el backend rechazo
 * mi credencial" de un 401 cualquiera (de un proxy, por ejemplo). No es una
 * prueba criptografica del origen de la respuesta.
 */
export const DEVICE_CREDENTIAL_REJECTED = 'DEVICE_CREDENTIAL_REJECTED';

/** Texto que ya devolvia el login; se conserva por compatibilidad. */
export const DEVICE_CREDENTIAL_REJECTED_MESSAGE = 'Invalid device credentials';

/**
 * Rechazo confirmado de la credencial del dispositivo en el login.
 *
 * El cuerpo es el mismo que el `UnauthorizedException` de siempre mas `code`:
 *
 * ```json
 * {
 *   "statusCode": 401,
 *   "code": "DEVICE_CREDENTIAL_REJECTED",
 *   "message": "Invalid device credentials",
 *   "error": "Unauthorized"
 * }
 * ```
 *
 * Todos los motivos comparten cuerpo a proposito: no se revela cual fue. Solo
 * lo lanza `DeviceAuthService.login`; un fallo de infraestructura nunca llega
 * aqui y sigue saliendo como 500.
 */
export class DeviceCredentialRejectedException extends UnauthorizedException {
  constructor() {
    super({
      statusCode: HttpStatus.UNAUTHORIZED,
      code: DEVICE_CREDENTIAL_REJECTED,
      message: DEVICE_CREDENTIAL_REJECTED_MESSAGE,
      error: 'Unauthorized',
    });
  }
}
