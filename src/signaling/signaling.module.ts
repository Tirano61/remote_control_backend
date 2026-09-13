import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { RemoteSession } from '../remote-sessions/entities/remote-session.entity';
import { TechniciansGateway } from './gateway/technicians.gateway';
import { SignalingRealtimeService } from './realtime/signaling-realtime.service';
import { SignalingService } from './signaling.service';

/**
 * Signaling de WebRTC y namespace realtime de tecnicos.
 *
 * Modulo neutral respecto a los dos extremos: contiene la validacion de
 * participantes, las rooms de sesion y el relay, y lo usan tanto
 * `TechniciansGateway` (aqui dentro) como `DevicesGateway` (en `DevicesModule`).
 *
 * Registra `RemoteSession` en su propio `forFeature` en lugar de importar
 * `RemoteSessionsModule`: el signaling solo necesita LEER la sesion para
 * autorizar, no su servicio. Asi `DevicesModule` puede importar este modulo sin
 * que aparezcan dependencias circulares entre dispositivos, sesiones remotas y
 * el realtime de tecnicos.
 *
 * De `AuthModule` sale `AuthService`, que es como se reutiliza la autenticacion
 * de usuarios ya existente para los sockets de tecnico.
 */
@Module({
  providers: [SignalingService, SignalingRealtimeService, TechniciansGateway],
  imports: [TypeOrmModule.forFeature([RemoteSession]), AuthModule],
  exports: [SignalingService, SignalingRealtimeService],
})
export class SignalingModule {}
