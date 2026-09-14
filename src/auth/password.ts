import * as bcrypt from 'bcrypt';

/**
 * Coste bcrypt de la aplicacion: el mismo que ya usaba `AuthService` al crear
 * usuarios.
 */
const PASSWORD_SALT_ROUNDS = 10;

/**
 * Unico punto donde se hashea una contrasena de usuario.
 *
 * Existe para que el alta por API (`POST /auth/register`) y el alta por consola
 * del primer administrador (`npm run bootstrap:admin`) produzcan exactamente el
 * mismo formato de hash. Con dos algoritmos o dos costes distintos, un usuario
 * creado por un camino podria no poder autenticarse por el otro.
 */
export const hashPassword = (plainPassword: string): string =>
  bcrypt.hashSync(plainPassword, PASSWORD_SALT_ROUNDS);
