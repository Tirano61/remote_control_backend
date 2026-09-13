import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { User } from '../entities/user.entity';

/**
 * Devuelve el usuario autenticado que dejo JwtStrategy en la request.
 * `@GetUser()` devuelve el usuario completo, `@GetUser('email')` solo esa propiedad.
 */
export const GetUser = createParamDecorator(
  (data: keyof User | undefined, ctx: ExecutionContext) => {
    const { user } = ctx.switchToHttp().getRequest<{ user?: User }>();

    if (!user)
      throw new InternalServerErrorException('User not found (request)');

    return data ? user[data] : user;
  },
);
