import { Device } from '../entities/device.entity';

/**
 * Dispositivo tal como lo ve la API administrativa (tecnicos/admin).
 *
 * Los campos se enumeran a proposito: la entidad puede ganar columnas internas
 * que no deben salir solas por la API, y este DTO deja sitio para datos
 * calculados que no son columnas, como `isOnline`.
 */
export class DeviceResponseDto {
  id: string;

  publicId: string;

  name: string | null;

  manufacturer: string | null;

  model: string | null;

  androidVersion: string | null;

  appVersion: string | null;

  /** Estado administrativo persistido: el dispositivo esta habilitado. */
  isActive: boolean;

  /**
   * Presencia en tiempo real: el dispositivo tiene al menos un socket
   * autenticado conectado a esta instancia del backend.
   *
   * No es una columna de PostgreSQL y no debe confundirse con `isActive`: un
   * dispositivo habilitado que no esta conectado es `isActive: true` con
   * `isOnline: false`.
   */
  isOnline: boolean;

  createdAt: Date;

  updatedAt: Date;

  static fromEntity(device: Device, isOnline: boolean): DeviceResponseDto {
    return {
      id: device.id,
      publicId: device.publicId,
      name: device.name,
      manufacturer: device.manufacturer,
      model: device.model,
      androidVersion: device.androidVersion,
      appVersion: device.appVersion,
      isActive: device.isActive,
      isOnline,
      createdAt: device.createdAt,
      updatedAt: device.updatedAt,
    };
  }
}
