import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { RemoteSessionsService } from '../remote-sessions/remote-sessions.service';
import {
  IdentityRevocationService,
  RevocableIdentityKind,
} from '../revocation/identity-revocation.service';
import { DeviceCredentialsService } from './auth/device-credentials.service';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { DevicesService } from './devices.service';

/**
 * Un re-enrolamiento revoca la credencial anterior, asi que todo lo que se
 * autorizo con ella deja de valer: sockets, handshakes y signaling en vuelo, y
 * la sesion viva.
 *
 * Aqui se comprueba unicamente ese enganche: que la revocacion se levante, que
 * se levante DESPUES de confirmar la transaccion y que los avisos de cierre
 * salgan antes que ella (la tablet aun los recibe). La transaccion real, el
 * cierre de la sesion y el corte de sockets se prueban contra PostgreSQL y
 * Socket.IO reales en `test/revocation.db-spec.ts`.
 */
describe('DeviceEnrollmentService (revocacion de la credencial anterior)', () => {
  const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';

  const activation = {
    activated: true as const,
    deviceId: DEVICE_ID,
    publicId: '384-729-142',
    name: 'Tablet Tolva 01',
    deviceSecret: 'secret-solo-en-la-respuesta',
  };

  let deviceEnrollmentService: DeviceEnrollmentService;
  let revoke: jest.Mock;
  let announceSystemClosures: jest.Mock;
  let transaction: jest.Mock;
  let calls: string[];

  beforeEach(async () => {
    calls = [];
    revoke = jest.fn(() => calls.push('revoke'));
    announceSystemClosures = jest.fn(() => calls.push('announce'));
    transaction = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        DeviceEnrollmentService,
        { provide: DataSource, useValue: { transaction } },
        { provide: DevicesService, useValue: {} },
        { provide: DeviceCredentialsService, useValue: {} },
        {
          provide: RemoteSessionsService,
          useValue: {
            closeLiveSessionsWithin: jest.fn(),
            announceSystemClosures,
          },
        },
        { provide: IdentityRevocationService, useValue: { revoke } },
      ],
    }).compile();

    deviceEnrollmentService = moduleRef.get(DeviceEnrollmentService);
  });

  it('revoca el dispositivo tras una activacion confirmada, despues de avisar los cierres', async () => {
    transaction.mockImplementation(() => {
      // Todavia dentro de la transaccion: la credencial nueva aun no esta
      // confirmada, asi que no debe haberse revocado nada.
      expect(revoke).not.toHaveBeenCalled();

      return Promise.resolve(activation);
    });

    await expect(
      deviceEnrollmentService.activate({
        publicId: '384-729-142',
        code: '123456',
      }),
    ).resolves.toEqual(activation);

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(
      RevocableIdentityKind.DEVICE,
      DEVICE_ID,
    );
    expect(calls).toEqual(['announce', 'revoke']);
  });

  it('no revoca nada si la activacion es rechazada', async () => {
    transaction.mockResolvedValue(null);

    await expect(
      deviceEnrollmentService.activate({
        publicId: '384-729-142',
        code: '000000',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(revoke).not.toHaveBeenCalled();
    expect(announceSystemClosures).not.toHaveBeenCalled();
  });

  it('no revoca nada si la transaccion falla (rollback)', async () => {
    transaction.mockRejectedValue(new Error('connection terminated'));

    await expect(
      deviceEnrollmentService.activate({
        publicId: '384-729-142',
        code: '123456',
      }),
    ).rejects.toThrow('connection terminated');

    expect(revoke).not.toHaveBeenCalled();
  });
});
