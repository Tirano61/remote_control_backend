import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getEntityManagerToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DevicesModule } from '../devices/devices.module';
import { DevicesGateway } from '../devices/gateway/devices.gateway';
import { RemoteSessionsModule } from '../remote-sessions/remote-sessions.module';
import { RemoteSessionsService } from '../remote-sessions/remote-sessions.service';
import { TechniciansGateway } from './gateway/technicians.gateway';
import { SignalingRealtimeService } from './realtime/signaling-realtime.service';
import { TechnicianRealtimeService } from './realtime/technician-realtime.service';
import { SignalingModule } from './signaling.module';
import { SignalingService } from './signaling.service';

/**
 * Cableado de modulos.
 *
 * Las pruebas de signaling construyen los gateways con providers sueltos, asi
 * que no detectarian un `exports` olvidado. Aqui se compilan los modulos de
 * verdad; lo unico que se sustituye es la conexion a la base de datos, porque
 * para comprobar el grafo de dependencias no hace falta PostgreSQL.
 */
const fakeDataSource = {
  entityMetadatas: [],
  getRepository: () => ({}),
  createEntityManager: () => ({}),
  options: { type: 'postgres' },
} as unknown as DataSource;

@Global()
@Module({
  providers: [
    { provide: DataSource, useValue: fakeDataSource },
    { provide: getDataSourceToken(), useValue: fakeDataSource },
    { provide: getEntityManagerToken(), useValue: {} },
  ],
  exports: [DataSource, getDataSourceToken(), getEntityManagerToken()],
})
class FakeDatabaseModule {}

describe('SignalingModule (cableado)', () => {
  const previousEnv = { ...process.env };

  beforeAll(() => {
    // Los modulos exigen sus secretos al construirse. Jest no carga `.env`.
    process.env.JWT_SECRET_KEY ??= 'user-secret-for-tests';
    process.env.DEVICE_JWT_SECRET ??= 'device-secret-for-tests';
  });

  afterAll(() => {
    process.env = previousEnv;
  });

  it('resuelve el gateway de tecnicos y el servicio de signaling', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDatabaseModule, SignalingModule],
    }).compile();

    // Si AuthModule no exportara AuthService, esto fallaria aqui.
    expect(moduleRef.get(TechniciansGateway)).toBeDefined();
    expect(moduleRef.get(SignalingService)).toBeDefined();

    await moduleRef.close();
  });

  it('deja que DevicesModule use el signaling sin dependencias circulares', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDatabaseModule, DevicesModule],
    }).compile();

    // El gateway solo se instancia si `SignalingModule` exporta lo que usa.
    expect(moduleRef.get(DevicesGateway)).toBeDefined();
    expect(
      moduleRef.get(SignalingRealtimeService, { strict: false }),
    ).toBeInstanceOf(SignalingRealtimeService);

    await moduleRef.close();
  });

  it('deja que RemoteSessionsModule avise a un tecnico sin importar el signaling', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeDatabaseModule, RemoteSessionsModule],
    }).compile();

    // Solo se resuelve si `TechnicianRealtimeModule` exporta el servicio y es
    // realmente independiente de `SignalingModule`.
    expect(moduleRef.get(RemoteSessionsService)).toBeDefined();
    expect(
      moduleRef.get(TechnicianRealtimeService, { strict: false }),
    ).toBeInstanceOf(TechnicianRealtimeService);

    await moduleRef.close();
  });
});
