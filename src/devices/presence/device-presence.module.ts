import { Module } from '@nestjs/common';
import { DevicePresenceService } from './device-presence.service';

/**
 * Presencia en tiempo real de los dispositivos.
 *
 * Va en su propio modulo, sin dependencias, para que tanto el gateway como los
 * servicios que retiran una autorizacion puedan usarlo sin dependencias
 * circulares entre ellos.
 */
@Module({
  providers: [DevicePresenceService],
  exports: [DevicePresenceService],
})
export class DevicePresenceModule {}
