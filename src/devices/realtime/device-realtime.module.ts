import { Module } from '@nestjs/common';
import { DeviceRealtimeService } from './device-realtime.service';

/**
 * Salida de eventos hacia los dispositivos.
 *
 * Sin dependencias a proposito: lo importa tanto `DevicesModule` (el gateway
 * registra su namespace) como los modulos de dominio que necesitan avisar a
 * una tablet, sin que ninguno tenga que importar al otro.
 */
@Module({
  providers: [DeviceRealtimeService],
  exports: [DeviceRealtimeService],
})
export class DeviceRealtimeModule {}
