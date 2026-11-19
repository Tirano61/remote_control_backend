import { UnauthorizedException } from '@nestjs/common';

/**
 * Codigos estables del `connect_error` con el que el namespace `/devices`
 * rechaza un handshake.
 *
 * Son el contrato con `remote_control_device` (ver `docs/REALTIME.md`): el
 * cliente decide con ellos, nunca con el texto de `message`.
 */
export enum DeviceHandshakeErrorCode {
  /**
   * El backend comprobo el Device JWT y no lo acepta: falta, firma o
   * vencimiento invalidos, `tokenType` incorrecto, dispositivo inexistente o
   * inactivo, o credencial que ya no es la vigente. No se dice cual.
   */
  UNAUTHORIZED = 'DEVICE_AUTH_UNAUTHORIZED',

  /**
   * El backend no pudo terminar de comprobar el token (PostgreSQL caido o
   * lento, error del driver, fallo inesperado). No dice nada del token.
   */
  UNAVAILABLE = 'DEVICE_AUTH_UNAVAILABLE',
}

/**
 * Texto de un rechazo confirmado. Es el que el backend enviaba siempre, y el
 * que los clientes Android anteriores comparan para decidir renovar el token:
 * no se puede cambiar sin romperlos.
 */
export const DEVICE_HANDSHAKE_UNAUTHORIZED_MESSAGE = 'Unauthorized';

/**
 * Texto de un fallo de infraestructura. Distinto a proposito de
 * `Unauthorized`, para que ningun cliente lo lea como rechazo del token.
 */
export const DEVICE_HANDSHAKE_UNAVAILABLE_MESSAGE = 'Service unavailable';

/** Lo que viaja en `connect_error.data`. Nada mas. */
export interface DeviceHandshakeErrorData {
  code: DeviceHandshakeErrorCode;
}

/**
 * Error que se pasa a `next()` en el middleware del namespace.
 *
 * Socket.IO (protocolo 5) serializa de un `Error` de middleware solo `message`
 * y `data`, en el paquete `CONNECT_ERROR`:
 *
 * ```text
 * 44/devices,{"message":"Unauthorized","data":{"code":"DEVICE_AUTH_UNAUTHORIZED"}}
 * ```
 *
 * Ni `name`, ni `stack`, ni el error original salen del servidor: por eso el
 * error del driver nunca se adjunta aqui, ni siquiera como `cause`.
 */
export class DeviceHandshakeError extends Error {
  readonly data: DeviceHandshakeErrorData;

  private constructor(message: string, code: DeviceHandshakeErrorCode) {
    super(message);
    this.name = 'DeviceHandshakeError';
    this.data = { code };
  }

  static unauthorized(): DeviceHandshakeError {
    return new DeviceHandshakeError(
      DEVICE_HANDSHAKE_UNAUTHORIZED_MESSAGE,
      DeviceHandshakeErrorCode.UNAUTHORIZED,
    );
  }

  static unavailable(): DeviceHandshakeError {
    return new DeviceHandshakeError(
      DEVICE_HANDSHAKE_UNAVAILABLE_MESSAGE,
      DeviceHandshakeErrorCode.UNAVAILABLE,
    );
  }

  get code(): DeviceHandshakeErrorCode {
    return this.data.code;
  }
}

/**
 * Traduce el fallo de la autenticacion del handshake al error del contrato.
 *
 * Solo es rechazo lo que `DeviceAuthService` rechaza de forma explicita, con
 * `UnauthorizedException`, despues de haber obtenido una respuesta: firma o
 * vencimiento, `tokenType`, o el estado leido de la base de datos. Todo lo
 * demas (errores del driver, timeouts, `QueryFailedError`, un `TypeError`, un
 * valor lanzado que ni siquiera es un `Error`) es no saber, y no saber no
 * puede presentarse como "tu token no vale".
 *
 * En ambos casos el handshake se rechaza: la clasificacion solo elige el
 * motivo que ve el cliente, nunca deja pasar una conexion.
 */
export const classifyHandshakeFailure = (
  error: unknown,
): DeviceHandshakeError =>
  error instanceof UnauthorizedException
    ? DeviceHandshakeError.unauthorized()
    : DeviceHandshakeError.unavailable();

/**
 * Descripcion apta para el log del servidor de un fallo de infraestructura.
 *
 * Solo el tipo y, si lo trae, el codigo del driver (`ECONNREFUSED`, `57014`,
 * ...). Nunca el `message`: el de `QueryFailedError` incluye la consulta y el
 * de algunos errores de conexion, el usuario o el host de la base.
 *
 * Se mira la forma del objeto y no `instanceof Error`: los errores de red los
 * crea el nucleo de Node, que puede ser otro realm que el de quien los recibe.
 */
export const describeHandshakeFailure = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return typeof error;

  const { name, code, driverError } = error as {
    name?: unknown;
    code?: unknown;
    driverError?: { code?: unknown } | null;
  };

  const label = typeof name === 'string' ? name : 'object';
  const driverCode = driverError?.code;
  const shownCode =
    typeof code === 'string'
      ? code
      : typeof driverCode === 'string'
        ? driverCode
        : null;

  return shownCode ? `${label} ${shownCode}` : label;
};
