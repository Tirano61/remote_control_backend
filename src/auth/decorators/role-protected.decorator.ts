import { SetMetadata } from '@nestjs/common';
import { ValidRoles } from '../interfaces/valid-roles';

export const META_ROLES = 'roles';

/**
 * Guarda en la metadata del handler (o del controlador) los roles permitidos.
 * No usar directamente en las rutas: usar `@Auth(...roles)`.
 */
export const RoleProtected = (...roles: ValidRoles[]) =>
  SetMetadata(META_ROLES, roles);
