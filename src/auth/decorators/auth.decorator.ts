import { applyDecorators, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ValidRoles } from '../interfaces/valid-roles';
import { RoleProtected } from './role-protected.decorator';
import { UserRoleGuard } from '../guards/user-role.guard';

/**
 * Unico decorador para proteger rutas.
 *
 * - `@Auth()`                      -> requiere token valido (cualquier rol).
 * - `@Auth(ValidRoles.admin)`      -> requiere token valido y rol admin.
 * - `@Auth(ValidRoles.admin, ValidRoles.tecnico)` -> cualquiera de los roles indicados.
 *
 * Se puede aplicar a un handler o a todo el controlador.
 */
export function Auth(...roles: ValidRoles[]) {
  return applyDecorators(
    RoleProtected(...roles),
    UseGuards(AuthGuard(), UserRoleGuard),
  );
}
