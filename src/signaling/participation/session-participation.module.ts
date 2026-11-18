import { Module } from '@nestjs/common';
import { SessionParticipationService } from './session-participation.service';

/**
 * Registro de participantes de las sesiones remotas.
 *
 * Sin dependencias, igual que `TechnicianRealtimeModule`: lo importan
 * `SignalingModule` (que lo alimenta) y `RemoteSessionsModule` (que lo lee para
 * el cierre automatico) sin que aparezca ningun ciclo entre ellos.
 */
@Module({
  providers: [SessionParticipationService],
  exports: [SessionParticipationService],
})
export class SessionParticipationModule {}
