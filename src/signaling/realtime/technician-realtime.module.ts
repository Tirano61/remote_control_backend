import { Module } from '@nestjs/common';
import { TechnicianRealtimeService } from './technician-realtime.service';

/**
 * Salida de eventos hacia los tecnicos.
 *
 * Sin dependencias a proposito, igual que `DeviceRealtimeModule`: lo importa
 * tanto `SignalingModule` (donde vive el gateway que registra el namespace)
 * como los modulos de dominio que necesitan avisar a un tecnico, sin que
 * ninguno tenga que importar al otro.
 */
@Module({
  providers: [TechnicianRealtimeService],
  exports: [TechnicianRealtimeService],
})
export class TechnicianRealtimeModule {}
