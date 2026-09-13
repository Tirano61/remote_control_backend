import { User } from '../../auth/entities/user.entity';
import { SupportRequest } from '../entities/support-request.entity';
import { SupportRequestStatus } from '../enums/support-request-status.enum';

/**
 * Tecnico tal como lo ven la tablet y el listado de solicitudes.
 *
 * Solo informacion publica razonable: identifica a la persona que atiende, sin
 * email (es su identificador de acceso), roles ni ningun dato de la cuenta.
 *
 * Es tambien la representacion que usan `RemoteSession` y los eventos de sesion
 * remota: un unico criterio de que se publica de un tecnico, en un unico sitio.
 */
export class SupportRequestTechnicianDto {
  id: string;

  name: string;

  /** Relacion obligatoria, como la de `RemoteSession.technician`. */
  static fromTechnician(technician: User): SupportRequestTechnicianDto {
    return { id: technician.id, name: technician.fullName };
  }

  /** Relacion opcional: `null` mientras la solicitud no tenga tecnico. */
  static fromEntity(
    technician: SupportRequest['technician'],
  ): SupportRequestTechnicianDto | null {
    if (!technician) return null;

    return SupportRequestTechnicianDto.fromTechnician(technician);
  }
}

/**
 * Dispositivo dentro de una solicitud, para el listado de tecnicos.
 *
 * Lleva lo necesario para presentar la fila en la aplicacion del tecnico
 * (`384-729-142 / Tablet Tolva 01 / Samsung SM-X210 / ONLINE`).
 */
export class SupportRequestDeviceDto {
  id: string;

  publicId: string;

  name: string | null;

  manufacturer: string | null;

  model: string | null;

  /** Presencia en tiempo real. No es una columna y no se persiste. */
  isOnline: boolean;

  static fromEntity(
    device: SupportRequest['device'],
    isOnline: boolean,
  ): SupportRequestDeviceDto {
    return {
      id: device.id,
      publicId: device.publicId,
      name: device.name,
      manufacturer: device.manufacturer,
      model: device.model,
      isOnline,
    };
  }
}

/**
 * Solicitud de asistencia tal como sale por la API.
 *
 * Los campos se enumeran a proposito: la entidad puede ganar columnas internas
 * que no deben salir solas, y aqui hay sitio para datos calculados que no son
 * columnas, como `device.isOnline`.
 */
export class SupportRequestResponseDto {
  id: string;

  deviceId: string;

  status: SupportRequestStatus;

  technicianId: string | null;

  /** Se incluye cuando la relacion esta cargada; si no, `null`. */
  technician: SupportRequestTechnicianDto | null;

  createdAt: Date;

  assignedAt: Date | null;

  respondedAt: Date | null;

  closedAt: Date | null;

  /** Solo en las respuestas para tecnicos: la tablet ya sabe quien es. */
  device?: SupportRequestDeviceDto;

  /** Respuesta para el propio dispositivo autenticado. */
  static forDevice(supportRequest: SupportRequest): SupportRequestResponseDto {
    return {
      id: supportRequest.id,
      deviceId: supportRequest.deviceId,
      status: supportRequest.status,
      technicianId: supportRequest.technicianId,
      technician: SupportRequestTechnicianDto.fromEntity(
        supportRequest.technician,
      ),
      createdAt: supportRequest.createdAt,
      assignedAt: supportRequest.assignedAt,
      respondedAt: supportRequest.respondedAt,
      closedAt: supportRequest.closedAt,
    };
  }

  /** Respuesta para tecnicos/admin: agrega el dispositivo y su presencia. */
  static forTechnician(
    supportRequest: SupportRequest,
    isOnline: boolean,
  ): SupportRequestResponseDto {
    return {
      ...SupportRequestResponseDto.forDevice(supportRequest),
      device: SupportRequestDeviceDto.fromEntity(
        supportRequest.device,
        isOnline,
      ),
    };
  }
}

/**
 * Respuesta de `GET /support-requests/current`.
 *
 * Que la tablet no tenga ninguna solicitud activa es una situacion normal, no
 * un error: se responde `200` con `supportRequest: null` en lugar de un `404`,
 * asi el cliente distingue "no hay solicitud" de "el endpoint fallo".
 */
export class CurrentSupportRequestResponseDto {
  supportRequest: SupportRequestResponseDto | null;
}
