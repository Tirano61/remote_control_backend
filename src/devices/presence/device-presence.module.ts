import { Module } from '@nestjs/common';
import { IdentityRevocationModule } from '../../revocation/identity-revocation.module';
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
 *
 * `IdentityRevocationModule` (tampoco tiene dependencias) aporta la barrera de
 * revocacion: la presencia cierra los sockets de un dispositivo revocado.
 */
@Module({
  imports: [TechnicianRealtimeModule, IdentityRevocationModule],
  providers: [DevicePresenceService],
  exports: [DevicePresenceService],
})
export class DevicePresenceModule {}
