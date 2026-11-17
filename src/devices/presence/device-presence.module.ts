import { Module } from '@nestjs/common';
import { TechnicianRealtimeModule } from '../../signaling/realtime/technician-realtime.module';
import { DevicePresenceService } from './device-presence.service';

/**
 * Presencia en tiempo real de los dispositivos.
 *
 * Va en su propio modulo para que tanto el gateway como los servicios que
 * retiran una autorizacion puedan usarlo sin dependencias circulares entre
 * ellos.
 *
 * Su unica dependencia es `TechnicianRealtimeModule`, la salida de eventos hacia
 * los tecnicos (`device:presence-updated`). Ese modulo no tiene dependencias, asi
 * que no aparece ningun ciclo con `DevicesGateway` ni con `TechniciansGateway`.
 */
@Module({
  imports: [TechnicianRealtimeModule],
  providers: [DevicePresenceService],
  exports: [DevicePresenceService],
})
export class DevicePresenceModule {}
