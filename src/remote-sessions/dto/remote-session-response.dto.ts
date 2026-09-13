import { SupportRequestTechnicianDto } from '../../support-requests/dto/support-request-response.dto';
import { RemoteSession } from '../entities/remote-session.entity';
import { RemoteSessionEndedBy } from '../enums/remote-session-ended-by.enum';
import { RemoteSessionStatus } from '../enums/remote-session-status.enum';

/**
 * Dispositivo dentro de una sesion remota.
 *
 * Lo justo para identificarlo en la pantalla del tecnico y en la propia tablet.
 */
export class RemoteSessionDeviceDto {
  id: string;

  publicId: string;

  name: string | null;

  /** Presencia en tiempo real. No es una columna y no se persiste. */
  isOnline: boolean;

  static fromEntity(
    device: RemoteSession['device'],
    isOnline: boolean,
  ): RemoteSessionDeviceDto {
    return {
      id: device.id,
      publicId: device.publicId,
      name: device.name,
      isOnline,
    };
  }
}

/**
 * Sesion remota tal como sale por la API.
 *
 * Los campos se enumeran a proposito: la entidad no debe salir tal cual, ni
 * arrastrar la solicitud o el usuario completos. `deviceId` y `technicianId`
 * viajan dentro de sus objetos publicos, que es donde el cliente los espera.
 */
export class RemoteSessionResponseDto {
  id: string;

  supportRequestId: string;

  status: RemoteSessionStatus;

  createdAt: Date;

  connectedAt: Date | null;

  endedAt: Date | null;

  endedBy: RemoteSessionEndedBy | null;

  device: RemoteSessionDeviceDto;

  technician: SupportRequestTechnicianDto;

  /**
   * Requiere las relaciones `device` y `technician` cargadas.
   *
   * `isOnline` se calcula en el momento a partir de la presencia: no es una
   * columna y no se guarda en ningun sitio.
   */
  static fromEntity(
    remoteSession: RemoteSession,
    isOnline: boolean,
  ): RemoteSessionResponseDto {
    return {
      id: remoteSession.id,
      supportRequestId: remoteSession.supportRequestId,
      status: remoteSession.status,
      createdAt: remoteSession.createdAt,
      connectedAt: remoteSession.connectedAt,
      endedAt: remoteSession.endedAt,
      endedBy: remoteSession.endedBy,
      device: RemoteSessionDeviceDto.fromEntity(remoteSession.device, isOnline),
      technician: SupportRequestTechnicianDto.fromTechnician(
        remoteSession.technician,
      ),
    };
  }
}

/**
 * Respuesta de `GET /device/remote-sessions/current`.
 *
 * Que la tablet no tenga sesion viva es una situacion normal, no un error: se
 * responde `200` con `remoteSession: null` en lugar de un `404`, igual que en
 * `GET /support-requests/current`.
 */
export class CurrentRemoteSessionResponseDto {
  remoteSession: RemoteSessionResponseDto | null;
}
