import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Device } from '../../entities/device.entity';
import { DEVICE_REQUEST_PROPERTY } from '../guards/device-jwt.guard';

/**
 * Devuelve el dispositivo autenticado que dejo DeviceJwtStrategy en la request.
 * `@GetDevice()` devuelve el dispositivo completo, `@GetDevice('publicId')`
 * solo esa propiedad.
 */
export const GetDevice = createParamDecorator(
  (data: keyof Device | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ device?: Device }>();
    const device = request[DEVICE_REQUEST_PROPERTY];

    if (!device)
      throw new InternalServerErrorException('Device not found (request)');

    return data ? device[data] : device;
  },
);
