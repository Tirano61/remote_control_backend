import { AddressInfo, createServer, Server, Socket } from 'net';
import { Client } from 'pg';
import { QueryFailedError } from 'typeorm';

/**
 * Fallos de infraestructura de verdad, sin PostgreSQL.
 *
 * Los errores no se fabrican a mano: los produce el driver `pg` al intentar
 * hablar con un puerto local donde no escucha nadie (conexion rechazada) o con
 * un servidor TCP que acepta y nunca contesta (timeout de conexion). Solo el
 * `QueryFailedError` se construye, con la clase real de TypeORM, porque
 * provocarlo exige un PostgreSQL que responda.
 *
 * Nada de esto toca una base de datos: los datos de conexion son ficticios y
 * todos los puertos son de `127.0.0.1`.
 */

const LOOPBACK = '127.0.0.1';

/** Datos de conexion ficticios: nunca llegan a ningun servidor real. */
const fictitiousConnection = (port: number) => ({
  host: LOOPBACK,
  port,
  user: 'rc_fictitious_user',
  password: 'rc-fictitious-password',
  database: 'rc_fictitious_db',
});

/** Un puerto local en el que no escucha nadie: conectar se rechaza. */
export const closedLoopbackPort = async (): Promise<number> => {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));

  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
};

/**
 * Servidor TCP que acepta conexiones y no contesta nunca: lo que ve el driver
 * cuando la red pierde paquetes o PostgreSQL esta colgado.
 */
export class SilentTcpServer {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();

  constructor() {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, LOOPBACK, resolve),
    );
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();

    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/**
 * Intenta una consulta con el driver `pg` contra `port` y relanza el error
 * genuino que produzca. Siempre falla: no hay PostgreSQL detras.
 */
export const queryThroughDriver = async (
  port: number,
  connectionTimeoutMillis = 0,
): Promise<never> => {
  const client = new Client({
    ...fictitiousConnection(port),
    connectionTimeoutMillis,
  });

  // Un error tardio del socket no debe tumbar el proceso de pruebas.
  client.on('error', () => undefined);

  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    void client.end().catch(() => undefined);
  }

  throw new Error(`Se esperaba un fallo del driver contra el puerto ${port}`);
};

/** Captura el error que produce `queryThroughDriver`. */
export const driverErrorAgainst = async (
  port: number,
  connectionTimeoutMillis = 0,
): Promise<Error> => {
  try {
    await queryThroughDriver(port, connectionTimeoutMillis);
  } catch (error) {
    return error as Error;
  }

  throw new Error('inalcanzable');
};

/** Texto de la consulta que lleva el `QueryFailedError`; no debe filtrarse. */
export const FAILED_QUERY_SQL =
  'SELECT "Device"."id" AS "Device_id" FROM "device" "Device" WHERE "Device"."id" = $1';

/**
 * `QueryFailedError` real de TypeORM con un error de driver como el que
 * devuelve PostgreSQL: por defecto, tabla inexistente (`42P01`). Con `57014`
 * es la cancelacion por `statement_timeout`.
 */
export const queryFailedError = (
  code = '42P01',
  message = 'relation "device" does not exist',
): QueryFailedError => {
  const driverError = Object.assign(new Error(message), {
    code,
    severity: 'ERROR',
  });

  return new QueryFailedError(
    FAILED_QUERY_SQL,
    ['550e8400-e29b-41d4-a716-446655440000'],
    driverError,
  );
};
