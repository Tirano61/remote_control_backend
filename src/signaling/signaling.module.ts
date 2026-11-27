import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { RemoteSession } from '../remote-sessions/entities/remote-session.entity';
import { IdentityRevocationModule } from '../revocation/identity-revocation.module';
import { TechniciansGateway } from './gateway/technicians.gateway';
import { SessionParticipationModule } from './participation/session-participation.module';
import { SignalingRealtimeService } from './realtime/signaling-realtime.service';
import { TechnicianRealtimeModule } from './realtime/technician-realtime.module';
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
 *
 * `TechnicianRealtimeModule` es la salida de eventos de dominio hacia los
 * tecnicos. Se importa aqui porque el gateway registra en el su namespace, y va
 * en un modulo propio sin dependencias para que quien emite (hoy
 * `RemoteSessionsModule`) no tenga que importar este.
 */
@Module({
  providers: [SignalingService, SignalingRealtimeService, TechniciansGateway],
  imports: [
    TypeOrmModule.forFeature([RemoteSession]),
    AuthModule,
    TechnicianRealtimeModule,
    // Registro de participantes de cada sesion: el signaling lo alimenta con
    // los joins validados y las desconexiones. Lo lee el cierre automatico de
    // `RemoteSessionsModule`, que importa el mismo modulo sin depender de este.
    SessionParticipationModule,
    // Barrera de revocacion: el gateway de tecnicos la consulta en el handshake
    // y en cada mensaje, y cierra los sockets de un tecnico revocado.
    IdentityRevocationModule,
  ],
  exports: [SignalingService, SignalingRealtimeService],
})
export class SignalingModule {}
