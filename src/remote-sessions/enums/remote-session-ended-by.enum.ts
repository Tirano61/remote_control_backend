/**
 * Quien cerro la sesion remota.
 *
 * Enum explicito y no strings sueltos: es informacion de auditoria y se guarda
 * tal cual en la base de datos.
 */
export enum RemoteSessionEndedBy {
  /** El tecnico finalizo la asistencia. */
  TECHNICIAN = 'TECHNICIAN',

  /** El usuario de la tablet corto la sesion. */
  DEVICE = 'DEVICE',

  /**
   * Cierre automatico del backend.
   *
   * Todavia no se emite: queda reservado para los timeouts y los cierres por
   * perdida de conexion, que aun no estan definidos.
   */
  SYSTEM = 'SYSTEM',
}
