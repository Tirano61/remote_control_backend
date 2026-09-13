import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { DeviceAuthModule } from '../devices/auth/device-auth.module';
import { DevicePresenceModule } from '../devices/presence/device-presence.module';
import { DeviceRealtimeModule } from '../devices/realtime/device-realtime.module';
import { SupportRequest } from '../support-requests/entities/support-request.entity';
import { DeviceRemoteSessionsController } from './device-remote-sessions.controller';
import { RemoteSession } from './entities/remote-session.entity';
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
  providers: [RemoteSessionsService],
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
  ],
  exports: [TypeOrmModule, RemoteSessionsService],
})
export class RemoteSessionsModule {}
