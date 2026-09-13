<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>


# Ejecutar en desarrollo


1. Colonar el repo

2. Ejecutar 
```
  npm install
```

3. Tener Nest CLI instalado
```
nm i -g @nestjs/cli
```

4. Levantar la base de datos
```
docker-compose up -d
```
### Packages
 * Configurar las variables de entorno
    ```
    pm i @nestjs/config
    app.module.ts  ConfigModule.forRoot(),
    ```
    
 * Base de datos
    ```
    npm install --save @nestjs/typeorm typeorm pg
    app.module.ts
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: +(process.env.BD_PORT ?? 5432), 
      database: process.env.POSTGRES_DB_NAME,
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      autoLoadEntities: true,
      synchronize: true, // generalmente se usa en true en desarrollo, en produccionse hace una migracion
    }),
    ```

  * Encriptar contraseña
    ```
    npm i bcrypt
    npm i --save-dev @types/bcrypt
    ```

  * JWT
    ```
    npm install --save @nestjs/passport passport
    npm install --save @nestjs/jwt passport-jwt
    npm install --save-dev @types/passport-jwt
    ```

## Migraciones / Uso de pgvector

Para usar pgvector y tener la columna `embedding` (tipo `vector(1536)`) en la tabla `sales_materials` ejecuta la migración TypeORM incluida. Usamos migraciones porque:

- TypeORM no reconoce nativamente el tipo `vector` y puede lanzar `DataTypeNotSupportedError` si intenta validar/crear ese tipo automáticamente.
- Mantener `synchronize: false` y aplicar migraciones evita cambios inesperados en producción y nos permite crear la extensión y la columna `embedding` de forma controlada.

Comando para ejecutar la migración (desde la raíz del proyecto):

```bash
# instalar ts-node si hace falta (solo si ejecutas migraciones en .ts)
npm install -D ts-node

# ejecutar la migración usando el data-source proporcionado
npx typeorm migration:run --dataSource src/data-source.ts
```

Requisitos y notas:
- Asegúrate de tener las variables de conexión en el entorno (.env) (POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB_NAME, BD_HOST, BD_PORT).
- La migración crea las extensiones necesarias (`uuid-ossp`, `vector`) y la tabla `sales_materials` con la columna `embedding vector(1536)`.
- Mantén `synchronize: false` en `TypeOrmModule.forRoot(...)` para que TypeORM no intente crear/alterar tipos no soportados.
- En la entidad de Nest no mapeamos la columna `embedding` (evitamos `@Column('vector', ...)`) — se actualiza desde el servicio con una query raw (ej. usando `pgvector.toSql(embedding)`).
- Si necesitas ejecutar el SQL manualmente en vez de usar TypeORM CLI, hay un archivo SQL en `migrations/001_create_sales_materials.sql` (si añadiste la opción A).  

Ejemplo rápido de uso en service (ya incluido en el proyecto):
- Guardar el registro con TypeORM (entidad sin `embedding`).
- Pedir embedding a OpenAI.
- Actualizar la columna vector con una query raw:
```sql
UPDATE sales_materials SET embedding = '[0.1,0.2,...]'::vector WHERE id = $1;
```

Si tienes dudas al ejecutar `npx typeorm migration:run`, pega el error y te indico el paso siguiente.







