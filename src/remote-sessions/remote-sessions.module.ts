import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import {
  REMOTE_SESSION_CONNECTING_TTL_MS_ENV,
  REMOTE_SESSION_DISCONNECT_GRACE_MS_ENV,
  REMOTE_SESSION_LIFECYCLE_CONFIG,
  REMOTE_SESSION_STARTUP_RECOVERY_MS_ENV,
  resolveRemoteSessionLifecycleConfig,
} from '../config/remote-session-lifecycle.config';
import { DeviceAuthModule } from '../devices/auth/device-auth.module';
import { DevicePresenceModule } from '../devices/presence/device-presence.module';
import { DeviceRealtimeModule } from '../devices/realtime/device-realtime.module';
import { SessionParticipationModule } from '../signaling/participation/session-participation.module';
import { TechnicianRealtimeModule } from '../signaling/realtime/technician-realtime.module';
import { SupportRequest } from '../support-requests/entities/support-request.entity';
import { DeviceRemoteSessionsController } from './device-remote-sessions.controller';
import { RemoteSession } from './entities/remote-session.entity';
import { RemoteSessionLifecycleService } from './lifecycle/remote-session-lifecycle.service';
import { RemoteSessionsController } from './remote-sessions.controller';
import { RemoteSessionsService } from './remote-sessions.service';

/**
 * Sesiones remotas.
 *
 * Modulo propio y no una parte de `SupportRequestsModule`: la solicitud es la
 * autorizacion y la sesion es el acceso, con ciclos de vida distintos.
 *
 * Registra `SupportRequest` en su propio `forFeature` en lugar de importar
 * `SupportRequestsModule`: solo necesita leer y completar la solicitud, no su
 * servicio, y asi los dos dominios no quedan acoplados. El registro aporta la
 * metadata de la entidad; las consultas las hace el `EntityManager` de la
 * transaccion, que es lo unico que sostiene el lock de la fila.
 */
@Module({
  controllers: [DeviceRemoteSessionsController, RemoteSessionsController],
  providers: [
    RemoteSessionsService,
    // Cierre automatico de sesiones abandonadas (endedBy SYSTEM).
    RemoteSessionLifecycleService,
    // Tiempos validados al arrancar: un valor invalido impide arrancar.
    {
      provide: REMOTE_SESSION_LIFECYCLE_CONFIG,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        resolveRemoteSessionLifecycleConfig({
          [REMOTE_SESSION_DISCONNECT_GRACE_MS_ENV]: configService.get<string>(
            REMOTE_SESSION_DISCONNECT_GRACE_MS_ENV,
          ),
          [REMOTE_SESSION_CONNECTING_TTL_MS_ENV]: configService.get<string>(
            REMOTE_SESSION_CONNECTING_TTL_MS_ENV,
          ),
          [REMOTE_SESSION_STARTUP_RECOVERY_MS_ENV]: configService.get<string>(
            REMOTE_SESSION_STARTUP_RECOVERY_MS_ENV,
          ),
        }),
    },
  ],
  imports: [
    TypeOrmModule.forFeature([RemoteSession, SupportRequest]),
    // Aporta Passport/JwtStrategy para `@Auth()` en las rutas de tecnicos.
    AuthModule,
    // Aporta la estrategia `device-jwt` para `@DeviceAuth()` en las de tablet.
    DeviceAuthModule,
    // Presencia: no se inicia una sesion contra un dispositivo OFFLINE, y las
    // respuestas incluyen `device.isOnline` calculado al momento.
    DevicePresenceModule,
    // Salida de eventos hacia la tablet (`remote-session:created` / `:closed`).
    DeviceRealtimeModule,
    // Salida de eventos hacia el tecnico (`remote-session:closed` cuando cierra
    // el dispositivo). Es un modulo sin dependencias: no arrastra el signaling.
    TechnicianRealtimeModule,
    // Quien participa de verdad en cada sesion (sockets unidos a su room de
    // signaling). Mismo modulo que alimenta SignalingModule: misma instancia.
    SessionParticipationModule,
    // Variables REMOTE_SESSION_* del cierre automatico.
    ConfigModule,
  ],
  exports: [TypeOrmModule, RemoteSessionsService],
})
export class RemoteSessionsModule {}
