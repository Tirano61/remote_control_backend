import { IsUUID } from 'class-validator';

/**
 * Payload de `remote-session:join`.
 *
 * Un unico campo a proposito: el participante NO se acepta del cliente (sale
 * del token del socket) y el nombre de la room lo construye el servidor.
 */
export class JoinRemoteSessionDto {
  @IsUUID()
  remoteSessionId: string;
}
