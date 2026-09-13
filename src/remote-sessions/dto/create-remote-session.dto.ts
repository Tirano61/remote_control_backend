import { IsUUID } from 'class-validator';

/**
 * Cuerpo de `POST /remote-sessions`.
 *
 * Un unico campo a proposito. El dispositivo y el tecnico de la sesion NO se
 * aceptan del cliente: salen de la solicitud y del usuario autenticado. Con
 * `forbidNonWhitelisted` activo en `main.ts`, mandar `deviceId` o
 * `technicianId` no es que se ignore, es que la peticion falla con `400`.
 */
export class CreateRemoteSessionDto {
  @IsUUID()
  supportRequestId: string;
}
