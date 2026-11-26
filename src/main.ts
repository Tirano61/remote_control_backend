import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import {
	resolveHttpCorsOrigins,
	resolveSocketIoCorsOrigins,
} from './config/cors.config';
import { resolveSocketIoHeartbeatConfig } from './config/socket-io-heartbeat.config';
import { SocketIoAdapter } from './config/socket-io.adapter';

async function bootstrap() {
	const app = await NestFactory.create(AppModule);
	// Sin CORS_ORIGINS se usan los mismos orígenes de desarrollo de siempre.
	app.enableCors({
		origin: resolveHttpCorsOrigins(),
		methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
		allowedHeaders: 'Content-Type, Authorization, Accept, Origin, X-Requested-With',
		credentials: true,
	});

	// Socket.IO tiene su propio CORS, que no se hereda del de HTTP y es del
	// servidor entero, no de cada namespace. Lo necesita sobre todo la Flutter
	// Web del técnico (/technicians); las tablets no son un navegador.
	//
	// El heartbeat (ping/pong de Engine.IO) tambien es del servidor entero: se
	// lee una sola vez aqui, cuando ConfigModule ya cargo el .env, y un valor
	// invalido impide arrancar.
	const heartbeat = resolveSocketIoHeartbeatConfig();
	app.useWebSocketAdapter(
		new SocketIoAdapter(app, resolveSocketIoCorsOrigins(), heartbeat),
	);
	new Logger('SocketIoAdapter').log(
		`Socket.IO heartbeat: pingInterval ${heartbeat.pingIntervalMs} ms, pingTimeout ${heartbeat.pingTimeoutMs} ms`,
	);

	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			forbidNonWhitelisted: true,
		})
	);
	await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
