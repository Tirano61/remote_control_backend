/** Marca que distingue un token de dispositivo de uno de usuario/tecnico. */
export const DEVICE_TOKEN_TYPE = 'device';

/**
 * Contenido de un Device JWT.
 *
 * Ademas de ir firmado con un secreto distinto al de los usuarios, lleva
 * `tokenType` para que un token de tecnico nunca pueda confundirse con uno de
 * dispositivo aunque alguna vez coincidieran los secretos.
 *
 * `credentialId` permite revocar los tokens ya emitidos: si la credencial deja
 * de ser la activa, el token deja de valer.
 */
export interface DeviceJwtPayload {
  sub: string;
  tokenType: typeof DEVICE_TOKEN_TYPE;
  credentialId: string;
}
