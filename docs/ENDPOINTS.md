# remote_control_backend — REST contract

These files document the current public contract of remote_control_backend.

If implementation and documentation ever disagree, the implementation must be
reviewed and the documentation updated in the same backend change.

Consumers of this contract:

```text
remote_control_device   Flutter app running on the Android tablet
remote_control_web      Flutter Web app used by technicians
```

The realtime (Socket.IO) contract lives in [REALTIME.md](REALTIME.md).

---

## Conventions

### Base URL

The application registers **no global prefix**. Routes are mounted directly at
the root of the HTTP server:

```text
http://<host>:<port>/auth/login
```

The port comes from `PORT` and defaults to `3000`. The server binds to `0.0.0.0`.

### Content type

All request bodies and all responses are `application/json`.

### Authentication headers

Three authentication modes exist. They are never interchangeable.

```text
Public       No header.
User JWT     Authorization: Bearer <user token>
Device JWT   Authorization: Bearer <device token>
```

User tokens and Device tokens are signed with **different secrets**
(`JWT_SECRET_KEY` and `DEVICE_JWT_SECRET`) and a Device JWT additionally carries
`tokenType: "device"`. A user token presented to a device-protected route fails,
and the other way around.

Token lifetimes:

```text
User JWT     2h    (fixed in code)
Device JWT   24h   (DEVICE_JWT_EXPIRES_IN, default 24h)
```

### Roles

Roles are the `ValidRoles` enum:

```text
admin
tecnico
sales
user
```

Only `admin` and `tecnico` are referenced by any endpoint today. `sales` and
`user` exist in the enum but no route requires them; `user` is the default role
of an account created without an explicit `roles` array.

Accounts are created only by an `admin` through `POST /auth/register`. There is
no public self-registration, and no endpoint changes the roles of an account
that already exists.

A route documented as `User JWT — roles: admin, tecnico` accepts a token whose
user holds **at least one** of those roles.

Holding `admin` does **not** bypass ownership rules. Where an endpoint is
ownership-scoped (remote sessions, for example), an `admin` still has to be the
technician the row belongs to.

### Validation

A global `ValidationPipe` runs with `whitelist: true` and
`forbidNonWhitelisted: true`. Consequences for the Flutter clients:

* any property that is not part of the DTO makes the whole request fail with
  `400`, it is not silently dropped;
* every `:id` path parameter documented as a UUID is parsed with
  `ParseUUIDPipe`, so a non-UUID value returns `400` before the handler runs.

### Common errors

```text
400 — Request body/params failed validation, or a malformed UUID was sent.
401 — Missing, malformed, expired or rejected token; or invalid credentials.
403 — Authenticated, but the user does not hold one of the required roles.
404 — The resource does not exist, or it exists but does not belong to the
      caller. Both cases answer the same on purpose: knowing a valid UUID
      must not confirm that somebody else's resource exists.
409 — The resource exists and belongs to the caller, but its current state
      does not allow the requested transition.
500 — Unexpected server error.
```

Clients must branch on the **HTTP status code**, not on the `message` string.
Message texts are not part of this contract and may change.

---

# Authentication — Web

Technician/user identity. Never used by the tablet.

## POST /auth/register

```text
CLIENT: administrative
```

Authentication:
User JWT — role: `admin`.

Description:
Creates a user account. There is **no public self-registration**: the users of
this backend represent authorised staff, so only an `admin` can create them. A
`tecnico` holding a valid token cannot create users and gets `403`.

The account is always created with `isActive: true`.

Request:

```json
{
  "email": "tecnico@example.com",
  "password": "Abc12345",
  "fullName": "Ana Torres",
  "roles": ["tecnico"]
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | yes | valid email |
| `password` | string | yes | 6–50 chars, must contain an uppercase letter, a lowercase letter, and a digit or symbol |
| `fullName` | string | yes | min length 1 |
| `roles` | string[] | no | non-empty array; every element must be a `ValidRoles` value (`admin`, `tecnico`, `sales`, `user`) |

Rules for `roles`:

```text
omitted      -> the account is created with the column default ["user"], which
                grants access to no technician or administrative endpoint.
                Omitting roles never promotes anybody to admin or tecnico.
[]           -> 400
["invalid"]  -> 400, and nothing is written
duplicates   -> removed; ["tecnico","tecnico"] is stored as ["tecnico"]
```

No other property is accepted. `id`, `isActive`, `created_at` and `updated_at`
are server-controlled, and sending any of them fails the whole request with
`400` (`forbidNonWhitelisted`).

Response 201:

```json
{
  "email": "tecnico@example.com",
  "fullName": "Ana Torres",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "isActive": true,
  "roles": ["tecnico"],
  "created_at": "2026-03-11T09:14:02.000Z",
  "updated_at": "2026-03-11T09:14:02.000Z",
  "token": "<user jwt>"
}
```

`password` is never returned.

The `token` in this response belongs to the **created** user, not to the admin
who made the call. The admin's own session is unaffected and the web app must
keep using its own token.

Errors:

```text
400 — Validation failed (unknown role included), or the email is already
      registered.
401 — Token missing, invalid or expired; user no longer exists; user is inactive.
403 — Authenticated, but the user does not hold the admin role.
500 — Unexpected error.
```

Notes:
Creating the **first** admin is not exposed through the API and never will be: a
public route able to create administrators would be a permanent open door. It is
a local console operation run by whoever deploys the backend:

```text
npm run bootstrap:admin
```

It reads `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` and
`BOOTSTRAP_ADMIN_FULL_NAME` from the environment, and creates the account only
if the database holds no administrator yet. It never promotes an existing
account. Details in `postman/README.md`. No HTTP endpoint takes part in this and
the Flutter clients are not involved.

Changing the roles of an existing account, deactivating it or deleting it is
also not exposed through the API yet.

## POST /auth/login

```text
CLIENT: remote_control_web
```

Authentication:
Public endpoint.

Request:

```json
{
  "email": "tecnico@example.com",
  "password": "Abc12345"
}
```

Both fields are required. `password` is validated with the same rules as in
register, so a password that does not match the pattern returns `400` and never
reaches the credential check.

Response 200:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "tecnico@example.com",
  "fullName": "Ana Torres",
  "roles": ["tecnico"],
  "isActive": true,
  "token": "<user jwt>"
}
```

Note the status code: a successful login answers **200 OK**, not the `201` that
Nest returns by default for `POST`. Logging in authenticates, it does not create
a resource. `POST /device-auth/login` also answers 200, so both logins behave
the same way.

This response does **not** include `created_at` / `updated_at`;
`GET /auth/check-status` does. Clients should not rely on the two shapes being
identical.

Errors:

```text
400 — Validation failed.
401 — Credentials are not valid, or the user exists but is inactive.
```

Notes:
An inactive user cannot log in. Wrong password and unknown email answer the
same `401`.

## GET /auth/check-status

```text
CLIENT: remote_control_web
```

Authentication:
User JWT. Any role.

Description:
Validates the current token, re-checks that the user still exists and is still
active, and returns the user together with a **renewed** token. Intended for
restoring a session when the Flutter Web app starts.

Request:
No body.

Response 200:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "tecnico@example.com",
  "fullName": "Ana Torres",
  "isActive": true,
  "roles": ["tecnico"],
  "created_at": "2026-03-11T09:14:02.000Z",
  "updated_at": "2026-03-11T09:14:02.000Z",
  "token": "<renewed user jwt>"
}
```

Errors:

```text
401 — Token missing, invalid or expired; user no longer exists; user is inactive.
```

Notes:
The returned token is newly signed with a fresh 2h lifetime. The client should
replace the stored token with it.

---

# Devices administration — Web

Administrative device management. Protected as a whole with
`@Auth(ValidRoles.admin, ValidRoles.tecnico)`.

The tablet never calls these routes.

## POST /devices

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Description:
Registers a device. The backend generates `id` (UUID) and `publicId`
(`XXX-XXX-XXX`). The device is created enabled (`isActive: true`) and with no
credential: it cannot authenticate until it is enrolled.

Request:

```json
{
  "name": "Tablet Tolva 01",
  "manufacturer": "Samsung",
  "model": "SM-X210",
  "androidVersion": "14",
  "appVersion": "1.0.0"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | no | 1–100 |
| `manufacturer` | string | no | 1–100 |
| `model` | string | no | 1–100 |
| `androidVersion` | string | no | 1–50 |
| `appVersion` | string | no | 1–50 |

All fields are optional; an empty body `{}` is accepted.

Response 201:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "publicId": "384-729-142",
  "name": "Tablet Tolva 01",
  "manufacturer": "Samsung",
  "model": "SM-X210",
  "androidVersion": "14",
  "appVersion": "1.0.0",
  "isActive": true,
  "isOnline": false,
  "createdAt": "2026-03-11T09:14:02.000Z",
  "updatedAt": "2026-03-11T09:14:02.000Z"
}
```

Errors:

```text
400 — Validation failed, or a unique constraint was violated.
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
500 — A unique publicId could not be generated after several attempts.
```

Notes:
`publicId` is an identifier a user can read out loud to a technician. It is
**not** a credential and never authenticates anything by itself.

`isOnline` is realtime presence, computed per request; it is not a database
column. It must not be confused with `isActive`, the persisted administrative
state. A registered but disconnected device is `isActive: true, isOnline: false`.

## GET /devices

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Description:
All devices, newest first (`createdAt DESC`). Each row carries its current
`isOnline`.

Request:
No body, no query parameters.

Response 200:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "publicId": "384-729-142",
    "name": "Tablet Tolva 01",
    "manufacturer": "Samsung",
    "model": "SM-X210",
    "androidVersion": "14",
    "appVersion": "1.0.0",
    "isActive": true,
    "isOnline": true,
    "createdAt": "2026-03-11T09:14:02.000Z",
    "updatedAt": "2026-03-11T09:20:31.000Z"
  }
]
```

Errors:

```text
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
```

Notes:
Presence is held in memory by the backend instance that serves the request, so
with more than one instance a device connected elsewhere would read as
`isOnline: false`. Single-instance deployment is the current assumption.

## GET /devices/:id

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Path params:

```text
id — device UUID
```

Response 200:
Same object as one element of `GET /devices`.

Errors:

```text
400 — id is not a valid UUID.
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
404 — Device not found.
```

## PATCH /devices/:id

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Description:
Updates the administrative fields of a device. Only the properties present in
the body are applied.

Path params:

```text
id — device UUID
```

Request:

```json
{
  "name": "Tablet Tolva 02",
  "isActive": false
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | no | 1–100 |
| `manufacturer` | string | no | 1–100 |
| `model` | string | no | 1–100 |
| `androidVersion` | string | no | 1–50 |
| `appVersion` | string | no | 1–50 |
| `isActive` | boolean | no | — |

`id`, `publicId`, `createdAt` and `updatedAt` are server-controlled and are
rejected by the validation pipe.

Response 200:
The updated device, same shape as `GET /devices/:id`.

Errors:

```text
400 — Validation failed, id is not a valid UUID, or a unique constraint was violated.
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
404 — Device not found.
```

Notes:
Setting `isActive: false` immediately **force-closes every open Socket.IO
connection** of that device, so it also becomes `isOnline: false`. Authorization
is not left to expire with the Device JWT.

A deactivated device also stops passing `@DeviceAuth()`, so all its REST calls
start failing with `401`.

## POST /devices/:id/enrollment

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Description:
Generates the 6-digit activation code that the technician reads out to the user
of the tablet. Issuing a new code **revokes every previous pending code** of
that device.

Path params:

```text
id — device UUID
```

Request:
No body.

Response 201:

```json
{
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "publicId": "384-729-142",
  "enrollmentCode": "418902",
  "expiresAt": "2026-03-11T09:44:02.000Z"
}
```

Errors:

```text
400 — id is not a valid UUID, or the device is not active and cannot be enrolled.
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
404 — Device not found.
```

Notes:
`enrollmentCode` travels in clear text **once**, in this response only. The
backend stores a bcrypt hash of it. It cannot be read again; a lost code means
generating a new one.

The code expires 30 minutes after it is issued, is single-use, and is
invalidated after 5 failed activation attempts against it.

---

# Device enrollment — Device

## POST /device-enrollment/activate

```text
CLIENT: remote_control_device
```

Authentication:
Public endpoint.

Description:
The tablet exchanges its `publicId` plus the activation code for a permanent
`deviceSecret`. This is the moment the device gets its own identity; it never
uses technician credentials.

The tablet may also send its technical information here; the fields present are
written onto the device record.

Request:

```json
{
  "publicId": "384-729-142",
  "code": "418902",
  "manufacturer": "Samsung",
  "model": "SM-X210",
  "androidVersion": "14",
  "appVersion": "1.0.0"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `publicId` | string | yes | `XXX-XXX-XXX`, digits only (`/^\d{3}-\d{3}-\d{3}$/`) |
| `code` | string | yes | exactly 6 digits (`/^\d{6}$/`) |
| `manufacturer` | string | no | 1–100 |
| `model` | string | no | 1–100 |
| `androidVersion` | string | no | 1–50 |
| `appVersion` | string | no | 1–50 |

No other field is accepted — `id`, `name` and `isActive` in particular are not
settable by the device.

Response 200:

```json
{
  "activated": true,
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "publicId": "384-729-142",
  "name": "Tablet Tolva 01",
  "deviceSecret": "<opaque base64url secret>"
}
```

Errors:

```text
400 — Validation failed (bad publicId format, code not 6 digits, unknown field).
401 — Activation rejected.
```

Notes:
`deviceSecret` is delivered **once and only here**. The tablet must persist it
in secure storage; if it is lost the device has to be enrolled again. The
backend keeps only a hash of it and never returns it again.

`401` is deliberately undifferentiated: unknown `publicId`, inactive device,
wrong code, expired code and already-used code all answer identically, so
guessing cannot be used to probe the system.

A successful activation revokes the previous credential of that device and
**force-closes its open Socket.IO connections**; the tablet reconnects with the
new credential.

---

# Device authentication — Device

## POST /device-auth/login

```text
CLIENT: remote_control_device
```

Authentication:
Public endpoint. The device credential is what authorizes the call.

Description:
Exchanges the permanent `deviceSecret` for a Device JWT.

Request:

```json
{
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "deviceSecret": "<opaque base64url secret>"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `deviceId` | string | yes | UUID |
| `deviceSecret` | string | yes | 32–200 chars, `[A-Za-z0-9_-]` only |

`publicId` is not accepted here: it does not authenticate.

Response 200:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "publicId": "384-729-142",
  "name": "Tablet Tolva 01",
  "isActive": true,
  "token": "<device jwt>"
}
```

Errors:

```text
400 — Validation failed.
401 — Invalid device credentials.
```

Notes:
All rejection reasons (unknown device, inactive device, revoked credential,
wrong secret) answer the same `401`.

The returned token is the credential for every `@DeviceAuth()` route and for the
`/devices` Socket.IO namespace. It expires after `DEVICE_JWT_EXPIRES_IN`
(default `24h`); when it does, the tablet calls this endpoint again with the
stored `deviceSecret`.

## GET /device-auth/check-status

```text
CLIENT: remote_control_device
```

Authentication:
Device JWT.

Description:
Validates the current Device JWT and returns the authenticated device.

Request:
No body.

Response 200:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "publicId": "384-729-142",
  "name": "Tablet Tolva 01",
  "isActive": true
}
```

Errors:

```text
401 — Token missing, invalid, expired or of the wrong type; device deactivated;
      credential revoked by a re-enrollment.
```

Notes:
Unlike `GET /auth/check-status`, this endpoint does **not** renew the token.
There is no `token` field in the response. Renewal is done through
`POST /device-auth/login`.

---

# Support requests — Device

Mounted under the `/support-requests` prefix and protected as a whole with
`@DeviceAuth()`. The device identity always comes from the Device JWT; no
endpoint in this group accepts a `deviceId`.

## POST /support-requests

```text
CLIENT: remote_control_device
```

Authentication:
Device JWT.

Description:
The user of the tablet presses "request assistance". Creates a support request
in state `WAITING` for the authenticated device.

Request:
Empty body.

Response 201:

```json
{
  "id": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77",
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "WAITING",
  "technicianId": null,
  "technician": null,
  "createdAt": "2026-03-11T09:30:00.000Z",
  "assignedAt": null,
  "respondedAt": null,
  "closedAt": null
}
```

Errors:

```text
401 — Not authenticated as a device.
403 — The device is inactive. (Defensive check: `@DeviceAuth()` already rejects
      an inactive device with 401, so this is not reachable in practice.)
409 — The device already has an active support request.
```

Notes:
A device may have only one support request in an active state (`WAITING`,
`ASSIGNED`, `ACCEPTED`) at a time. The rule is enforced by a partial unique index
in PostgreSQL, not by a prior read, so two simultaneous requests cannot both
succeed.

## GET /support-requests/current

```text
CLIENT: remote_control_device
```

Authentication:
Device JWT.

Description:
Returns the active support request of the authenticated device. This is how the
tablet recovers state after a restart, a reconnection, or a missed Socket.IO
event.

Request:
No body.

Response 200 — with an active request:

```json
{
  "supportRequest": {
    "id": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77",
    "deviceId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "ASSIGNED",
    "technicianId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "technician": {
      "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "name": "Ana Torres"
    },
    "createdAt": "2026-03-11T09:30:00.000Z",
    "assignedAt": "2026-03-11T09:31:12.000Z",
    "respondedAt": null,
    "closedAt": null
  }
}
```

Response 200 — with none:

```json
{ "supportRequest": null }
```

Errors:

```text
401 — Not authenticated as a device.
```

Notes:
Having no active request is a normal situation and answers `200` with `null`,
not `404`. The client can therefore tell "no request" apart from "the call
failed".

Routing detail: this path is matched by the device controller, which is
registered before the technician controller that owns `GET /support-requests/:id`.
A technician token sent here gets `401`, not the request whose id is `current`.

## POST /support-requests/:id/accept

```text
CLIENT: remote_control_device
```

Authentication:
Device JWT.

Description:
The user of the tablet authorizes the assigned technician to continue:
`ASSIGNED -> ACCEPTED`.

Path params:

```text
id — support request UUID
```

Request:
Empty body.

Response 200:
The updated support request, same shape as the `supportRequest` object above,
with `status: "ACCEPTED"` and `respondedAt` set.

Errors:

```text
400 — id is not a valid UUID.
401 — Not authenticated as a device.
404 — The request does not exist, or belongs to another device.
409 — The request is not in ASSIGNED.
```

Notes:
`ACCEPTED` only means the user authorized that technician. It does **not** create
a remote session; the technician still has to call `POST /remote-sessions`.

## POST /support-requests/:id/reject

```text
CLIENT: remote_control_device
```

Authentication:
Device JWT.

Description:
The user refuses the assigned technician: `ASSIGNED -> REJECTED`. Terminal.

Path params:

```text
id — support request UUID
```

Request:
Empty body.

Response 200:
The updated support request with `status: "REJECTED"`, `respondedAt` and
`closedAt` set.

Errors:

```text
400 — id is not a valid UUID.
401 — Not authenticated as a device.
404 — The request does not exist, or belongs to another device.
409 — The request is not in ASSIGNED.
```

## POST /support-requests/:id/cancel

```text
CLIENT: remote_control_device
```

Authentication:
Device JWT.

Description:
The user withdraws the request. Allowed from `WAITING`, `ASSIGNED` and
`ACCEPTED`. Terminal (`CANCELLED`).

Path params:

```text
id — support request UUID
```

Request:
Empty body.

Response 200:
The updated support request with `status: "CANCELLED"` and `closedAt` set.

Errors:

```text
400 — id is not a valid UUID.
401 — Not authenticated as a device.
404 — The request does not exist, or belongs to another device.
409 — The request is already in a terminal state, OR remote assistance has
      already started and the remote session must be closed instead.
```

Notes:
Once a live `RemoteSession` exists for the request, cancelling is refused with
`409`. The tablet must call `POST /device/remote-sessions/:id/close`, which
closes the session and completes the request together. Both `409` cases share
the status code, so the client should re-read state
(`GET /support-requests/current`, `GET /device/remote-sessions/current`) rather
than parse the message.

---

# Support requests — Web

Mounted under the `/support-requests` prefix and protected as a whole with
`@Auth(ValidRoles.admin, ValidRoles.tecnico)`.

## GET /support-requests

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Description:
Support request queue, oldest first (`createdAt ASC`), so the longest-waiting
request is on top. Each row carries the device and its realtime `isOnline`.

Query params:

| Param | Type | Required | Values |
|---|---|---|---|
| `status` | enum | no | `WAITING`, `ASSIGNED`, `ACCEPTED`, `REJECTED`, `CANCELLED`, `COMPLETED` |

Without `status` every request is returned.

Response 200:

```json
[
  {
    "id": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77",
    "deviceId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "WAITING",
    "technicianId": null,
    "technician": null,
    "createdAt": "2026-03-11T09:30:00.000Z",
    "assignedAt": null,
    "respondedAt": null,
    "closedAt": null,
    "device": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "publicId": "384-729-142",
      "name": "Tablet Tolva 01",
      "manufacturer": "Samsung",
      "model": "SM-X210",
      "isOnline": true
    }
  }
]
```

Errors:

```text
400 — status is not one of the enum values.
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
```

Notes:
An unknown `status` value is a `400`, not an empty list.

The `device` block is present only in the technician-facing responses; the
device-facing ones omit it, since the tablet already knows which device it is.

`technician` never exposes the account email or the roles — only `id` and `name`.

## GET /support-requests/:id

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Path params:

```text
id — support request UUID
```

Response 200:
One element with the same shape as `GET /support-requests`.

Errors:

```text
400 — id is not a valid UUID.
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
404 — Support request not found.
```

Notes:
Not ownership-scoped: any `admin`/`tecnico` can read any support request.

## POST /support-requests/:id/assign

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Description:
The technician presses "take request": `WAITING -> ASSIGNED`.

Path params:

```text
id — support request UUID
```

Request:
Empty body. `technicianId` is **not** accepted — the technician is the
authenticated user.

Response 200:
The updated support request with `status: "ASSIGNED"`, `technicianId`,
`technician` and `assignedAt` set, plus the `device` block.

Errors:

```text
400 — id is not a valid UUID.
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
404 — Support request not found.
409 — The request is not WAITING; OR the device is offline; OR another
      technician took it first.
```

Notes:
A request whose device is `OFFLINE` cannot be assigned: the tablet could neither
be notified nor answer. The request stays `WAITING` — nothing is auto-cancelled,
because the device may reconnect.

On success the backend emits `support:assigned` to the device over Socket.IO.
Delivery is best-effort: if the tablet dropped in between, the assignment is
still valid and the tablet picks it up with `GET /support-requests/current`.

---

# Remote sessions — Device

Mounted under `/device/remote-sessions` — a different prefix from the technician
controller — and protected as a whole with `@DeviceAuth()`.

## GET /device/remote-sessions/current

```text
CLIENT: remote_control_device
```

Authentication:
Device JWT.

Description:
The live remote session of the authenticated device, if any. This is how the
tablet recovers its session after reconnecting, restarting the app, or missing
the Socket.IO event.

Request:
No body.

Response 200 — with a live session:

```json
{
  "remoteSession": {
    "id": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
    "supportRequestId": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77",
    "status": "CONNECTING",
    "createdAt": "2026-03-11T09:33:41.000Z",
    "connectedAt": null,
    "endedAt": null,
    "endedBy": null,
    "device": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "publicId": "384-729-142",
      "name": "Tablet Tolva 01",
      "isOnline": true
    },
    "technician": {
      "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "name": "Ana Torres"
    }
  }
}
```

Response 200 — with none:

```json
{ "remoteSession": null }
```

Errors:

```text
401 — Not authenticated as a device.
```

Notes:
"Live" means `status` is `CONNECTING` or `ACTIVE`. A `CLOSED` session is never
returned here.

`status` is `CONNECTING` for every session that exists today: nothing in the
current code transitions a session to `ACTIVE`, and `connectedAt` therefore stays
`null`. Signaling does not change the session state.

## POST /device/remote-sessions/:id/close

```text
CLIENT: remote_control_device
```

Authentication:
Device JWT.

Description:
The user of the tablet ends the assistance. The session becomes `CLOSED` with
`endedBy: "DEVICE"`, and its support request becomes `COMPLETED` in the same
transaction.

Path params:

```text
id — remote session UUID
```

Request:
Empty body.

Response 200:
The closed session, same shape as above, with `status: "CLOSED"`, `endedAt` set
and `endedBy: "DEVICE"`.

Errors:

```text
400 — id is not a valid UUID.
401 — Not authenticated as a device.
404 — The session does not exist, or belongs to another device.
409 — The session is already closed, or its support request is not in a state
      that can be completed.
```

Notes:
Closing the session also closes the support request. The two updates are
committed together: a `CLOSED` session with an `ACCEPTED` request cannot remain.

If the technician and the device close at the same instant, only one wins; the
other receives `409`, and the recorded `endedBy` / `endedAt` are those of the
first.

The device does **not** receive `remote-session:closed` for its own close — the
closing side already has the closed session in this HTTP response.

The technician **is** notified: after the transaction commits, the backend emits
`remote-session:closed` to that technician on the `/technicians` namespace. It is
a change notification, not state: the web app answers it with
`GET /remote-sessions/current`. Delivery is best-effort and never rolls the close
back — if the technician is not connected the event is lost and the session is
still `CLOSED`.

---

# Remote sessions — Web

Mounted under `/remote-sessions` and protected as a whole with
`@Auth(ValidRoles.admin, ValidRoles.tecnico)`.

Every endpoint in this group is additionally **ownership-scoped**: the session or
request must belong to the authenticated technician. `admin` is not exempt.

## POST /remote-sessions

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Description:
The technician presses "start assistance" on a request the tablet has accepted.
Creates the remote session in `CONNECTING`.

Request:

```json
{
  "supportRequestId": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `supportRequestId` | string | yes | UUID |

This is the only accepted field. Sending `deviceId` or `technicianId` does not
get ignored — it fails with `400`. The device comes from the support request and
the technician from the token.

Response 201:

```json
{
  "id": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
  "supportRequestId": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77",
  "status": "CONNECTING",
  "createdAt": "2026-03-11T09:33:41.000Z",
  "connectedAt": null,
  "endedAt": null,
  "endedBy": null,
  "device": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "publicId": "384-729-142",
    "name": "Tablet Tolva 01",
    "isOnline": true
  },
  "technician": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "name": "Ana Torres"
  }
}
```

Errors:

```text
400 — Validation failed (missing/invalid supportRequestId, or an extra field).
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
404 — The support request does not exist, or it is not assigned to the
      authenticated technician.
409 — The request was not accepted by the device; OR the authenticated
      technician already has a live remote session; OR the device is offline;
      OR the device already has a live remote session; OR the request already
      originated a remote session.
```

Notes:
Only an `ACCEPTED` support request authorizes remote control. Being an
authenticated technician grants nothing by itself.

There is no supervision or administrative takeover: an `admin` who is not the
assigned technician gets `404`, exactly like any other user.

A technician holds **at most one live session** (`CONNECTING` or `ACTIVE`).
Asking for a second one answers `409` even when it targets a different device;
the support request is left untouched and can be started later. Closing the open
session frees the technician immediately — there is no cleanup step and no
waiting period.

One live session per technician, one live session per device and one session per
support request are all enforced by unique indexes in PostgreSQL, not only by a
check in the application, so two simultaneous requests cannot both win: one gets
`201` and the other `409`.

On success the backend emits `remote-session:created` to the device over
Socket.IO, after the transaction commits. Delivery is best-effort; the tablet can
always recover with `GET /device/remote-sessions/current`.

## GET /remote-sessions/current

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Description:
The live remote session of the authenticated technician, if any. This is how the
web app recovers after an F5, after being closed and reopened, or after missing a
Socket.IO event, without having to treat a `remoteSessionId` kept in browser
storage as the source of truth.

Request:
No body. `technicianId` and `userId` are **not** accepted in the query, the body
or the path: the technician is the authenticated user and nothing else.

Response 200 — with a live session:

```json
{
  "remoteSession": {
    "id": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
    "supportRequestId": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77",
    "status": "CONNECTING",
    "createdAt": "2026-03-11T09:33:41.000Z",
    "connectedAt": null,
    "endedAt": null,
    "endedBy": null,
    "device": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "publicId": "384-729-142",
      "name": "Tablet Tolva 01",
      "isOnline": true
    },
    "technician": {
      "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "name": "Ana Torres"
    }
  }
}
```

Response 200 — with none:

```json
{ "remoteSession": null }
```

Errors:

```text
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
```

Notes:
Same envelope and same session object as `GET /device/remote-sessions/current`.
Having no live session is normal, not an error: it answers `200` with
`remoteSession: null`, never `404`.

"Live" means `status` is `CONNECTING` or `ACTIVE`. A `CLOSED` session is never
returned here; read a closed one by id with `GET /remote-sessions/:id`.

Ownership is part of the query, not a filter applied afterwards: only sessions
whose `technicianId` is the authenticated user are considered. A live session
belonging to another technician reads exactly like having none. Holding `admin`
changes nothing — an administrator recovers the sessions they own as the
assigned technician and no others; there is no supervision or takeover.

By design there is at most one live session per technician: a unique partial
index on `technicianId` (over `CONNECTING` and `ACTIVE`) makes a second one
impossible, which is why `POST /remote-sessions` answers `409` instead of
opening it. So this endpoint never has to choose between candidates — the
answer is that one session, or `null`.

The literal path segment `current` is routed before `:id`, so it is never parsed
as a session UUID.

## GET /remote-sessions/:id

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Path params:

```text
id — remote session UUID
```

Response 200:
The session, same shape as `POST /remote-sessions`. Closed sessions are returned
too, with `status: "CLOSED"`, `endedAt` and `endedBy`.

Errors:

```text
400 — id is not a valid UUID.
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
404 — The session does not exist, or belongs to another technician.
```

Notes:
Use this to read one specific session, closed ones included — for example the
session named by a `remote-session:closed` event. To recover "the session I have
open right now", use `GET /remote-sessions/current` instead: it does not depend
on the client remembering an id.

## POST /remote-sessions/:id/close

```text
CLIENT: remote_control_web
```

Authentication:
User JWT — roles: `admin`, `tecnico`.

Description:
The technician ends the assistance. The session becomes `CLOSED` with
`endedBy: "TECHNICIAN"` and its support request becomes `COMPLETED`, in the same
transaction.

Path params:

```text
id — remote session UUID
```

Request:
Empty body.

Response 200:
The closed session, with `status: "CLOSED"`, `endedAt` set and
`endedBy: "TECHNICIAN"`.

Errors:

```text
400 — id is not a valid UUID.
401 — Not authenticated.
403 — Authenticated without role admin/tecnico.
404 — The session does not exist, or belongs to another technician.
409 — The session is already closed, or its support request is not in a state
      that can be completed.
```

Notes:
On success the backend emits `remote-session:closed` to the device over
Socket.IO. No echo is sent back to the technician who closed: this HTTP response
already carries the closed session.

Closing the session immediately cuts signaling: the backend re-checks the session
on every `webrtc:*` message, so a closed session starts answering `UNAUTHORIZED`.

---

## Enumerations

Values the Flutter clients can receive. Clients should treat unknown future
values defensively.

### SupportRequestStatus

```text
WAITING     The tablet asked for assistance; no technician has taken it.
ASSIGNED    A technician took it; the user has not answered yet.
ACCEPTED    The user authorized that technician. Does NOT imply a session exists.
REJECTED    The user refused the technician. Terminal.
CANCELLED   The user withdrew the request. Terminal.
COMPLETED   A remote session existed and was closed. Terminal. Written only by
            the remote-session close path; no client can request it.
```

Active statuses (only one at a time per device): `WAITING`, `ASSIGNED`,
`ACCEPTED`.

### RemoteSessionStatus

```text
CONNECTING  The session exists and both ends may start connecting.
ACTIVE      Reserved. No code path sets it today.
CLOSED      The session ended. Terminal.
```

Live statuses (only one at a time per device): `CONNECTING`, `ACTIVE`.

### RemoteSessionEndedBy

```text
TECHNICIAN  Closed through POST /remote-sessions/:id/close
DEVICE      Closed through POST /device/remote-sessions/:id/close
SYSTEM      Reserved. No code path writes it today.
```

### ValidRoles

```text
admin
tecnico
sales
user
```

---

## Main REST flows

### Device enrollment

```text
1. POST   /devices                        (User JWT, admin|tecnico)
          -> device with id + publicId, no credential yet

2. POST   /devices/:id/enrollment         (User JWT, admin|tecnico)
          -> enrollmentCode (6 digits, 30 min, single use), shown once

3. POST   /device-enrollment/activate     (public, from the tablet)
          body: publicId + code (+ optional technical info)
          -> deviceSecret, delivered once and only here

4. POST   /device-auth/login              (public, from the tablet)
          body: deviceId + deviceSecret
          -> Device JWT (24h by default)

5. GET    /device-auth/check-status       (Device JWT)
          -> validates the token; does NOT renew it

6. Socket.IO connect to /devices with auth.token = Device JWT
```

Re-enrollment repeats steps 2–4: it revokes the previous credential, invalidates
the Device JWTs issued from it, and force-closes the device sockets.

### Support request

```text
1. POST   /support-requests                  (Device JWT)
          -> WAITING

2. GET    /support-requests?status=WAITING   (User JWT, admin|tecnico)
          -> the queue, oldest first, with device.isOnline

3. POST   /support-requests/:id/assign       (User JWT, admin|tecnico)
          -> ASSIGNED; requires the device to be ONLINE
          -> emits support:assigned to the device

4a. POST  /support-requests/:id/accept       (Device JWT)  -> ACCEPTED
4b. POST  /support-requests/:id/reject       (Device JWT)  -> REJECTED (terminal)
4c. POST  /support-requests/:id/cancel       (Device JWT)  -> CANCELLED (terminal)

At any point the tablet reads GET /support-requests/current to recover state.
```

### Remote session

```text
1. POST   /remote-sessions                (User JWT, admin|tecnico)
          body: supportRequestId of an ACCEPTED request owned by this technician
          -> RemoteSession CONNECTING
          -> emits remote-session:created to the device
          -> 409 if this technician already has a live session, even on
             another device: one technician, one live session

2a. GET   /device/remote-sessions/current (Device JWT)
          -> the tablet recovers the session after a restart or reconnection
2b. GET   /remote-sessions/current        (User JWT, admin|tecnico)
          -> the web app recovers the session after an F5 or a reopen

3a. POST  /remote-sessions/:id/close          (User JWT)   endedBy TECHNICIAN
                                                           -> emits remote-session:closed
                                                              to the device
3b. POST  /device/remote-sessions/:id/close   (Device JWT) endedBy DEVICE
                                                           -> emits remote-session:closed
                                                              to the technician

4. In both cases the SupportRequest becomes COMPLETED in the same transaction.
```

Once the session exists, WebRTC negotiation happens over Socket.IO — see
[REALTIME.md](REALTIME.md). No REST endpoint takes part in WebRTC, and none marks
a session as `ACTIVE`.
