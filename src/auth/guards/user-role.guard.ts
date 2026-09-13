import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { META_ROLES } from '../decorators/role-protected.decorator';
import { User } from '../entities/user.entity';
import { ValidRoles } from '../interfaces/valid-roles';

@Injectable()
export class UserRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Los roles del handler tienen prioridad sobre los del controlador.
    const validRoles = this.reflector.getAllAndOverride<ValidRoles[]>(
      META_ROLES,
      [context.getHandler(), context.getClass()],
    );

    // Sin roles declarados: basta con estar autenticado.
    if (!validRoles || validRoles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: User }>();

    // AuthGuard() siempre se ejecuta antes, asi que esto solo pasa por un error de configuracion.
    if (!user)
      throw new InternalServerErrorException('User not found (request)');

    const hasRole = user.roles.some((role) => validRoles.includes(role));
    if (hasRole) return true;

    throw new ForbiddenException(
      `User ${user.fullName} needs one of these roles: [${validRoles.join(', ')}]`,
    );
  }
}
