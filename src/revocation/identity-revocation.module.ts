import { Module } from '@nestjs/common';
import { IdentityRevocationService } from './identity-revocation.service';

/**
 * Barrera de revocacion compartida por los dos gateways y por los flujos que
 * retiran una autorizacion.
 *
 * Sin dependencias a proposito, igual que `DeviceRealtimeModule`: lo importan
 * `DevicesModule`, `SignalingModule` y `RemoteSessionsModule` sin que ninguno
 * tenga que importar a otro. Al no tener dependencias, Nest lo instancia una
 * sola vez para toda la aplicacion: todos ven la misma barrera.
 */
@Module({
  providers: [IdentityRevocationService],
  exports: [IdentityRevocationService],
})
export class IdentityRevocationModule {}
