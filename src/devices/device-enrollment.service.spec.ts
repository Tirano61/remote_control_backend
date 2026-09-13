import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DeviceCredentialsService } from './auth/device-credentials.service';
import { DeviceEnrollmentService } from './device-enrollment.service';
import { DevicesService } from './devices.service';
import { DevicePresenceService } from './presence/device-presence.service';

/**
 * Un re-enrolamiento revoca la credencial anterior, asi que los sockets
 * autenticados con ella dejan de estar autorizados.
 *
 * Aqui se comprueba unicamente ese enganche: que las conexiones se cierren, y
 * que se cierren despues de confirmar la transaccion. El cierre real de un
 * socket vivo se prueba en `gateway/devices.gateway.spec.ts`.
 */
describe('DeviceEnrollmentService (invalidacion de sockets)', () => {
  const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';

  const activation = {
    activated: true as const,
    deviceId: DEVICE_ID,
    publicId: '384-729-142',
    name: 'Tablet Tolva 01',
    deviceSecret: 'secret-solo-en-la-respuesta',
  };

  let deviceEnrollmentService: DeviceEnrollmentService;
  let disconnectDevice: jest.Mock;
  let transaction: jest.Mock;

  beforeEach(async () => {
    disconnectDevice = jest.fn();
    transaction = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        DeviceEnrollmentService,
        { provide: DataSource, useValue: { transaction } },
        { provide: DevicesService, useValue: {} },
        { provide: DeviceCredentialsService, useValue: {} },
        { provide: DevicePresenceService, useValue: { disconnectDevice } },
      ],
    }).compile();

    deviceEnrollmentService = moduleRef.get(DeviceEnrollmentService);
  });

  it('cierra las conexiones del dispositivo tras una activacion confirmada', async () => {
    transaction.mockImplementation(() => {
      // Todavia dentro de la transaccion: la credencial nueva aun no esta
      // confirmada, asi que no debe haberse cerrado nada.
      expect(disconnectDevice).not.toHaveBeenCalled();

      return Promise.resolve(activation);
    });

    await expect(
      deviceEnrollmentService.activate({
        publicId: '384-729-142',
        code: '123456',
      }),
    ).resolves.toEqual(activation);

    expect(disconnectDevice).toHaveBeenCalledTimes(1);
    expect(disconnectDevice).toHaveBeenCalledWith(DEVICE_ID);
  });

  it('no cierra ninguna conexion si la activacion es rechazada', async () => {
    transaction.mockResolvedValue(null);

    await expect(
      deviceEnrollmentService.activate({
        publicId: '384-729-142',
        code: '000000',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(disconnectDevice).not.toHaveBeenCalled();
  });
});
