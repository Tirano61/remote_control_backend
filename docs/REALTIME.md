# remote_control_backend — realtime (Socket.IO) contract

These files document the current public contract of remote_control_backend.

If implementation and documentation ever disagree, the implementation must be
reviewed and the documentation updated in the same backend change.

Consumers of this contract:

```text
remote_control_device   Flutter app running on the Android tablet
remote_control_web      Flutter Web app used by technicians
```

The REST contract lives in [ENDPOINTS.md](ENDPOINTS.md).

---

## Overview

The backend exposes **two Socket.IO namespaces**, one per identity:

```text
/devices       consumed by remote_control_device   (Device JWT)
/technicians   consumed by remote_control_web      (User JWT)
```

They run on the same Socket.IO server, on the same port as the HTTP API, at the
default Socket.IO path (`/socket.io`). They are separate namespaces and never
mix: a device never joins `/technicians` and a technician never joins `/devices`.

What realtime is used for today:

```text
device presence (ONLINE/OFFLINE)      — tracked from /devices sockets, server-side
device presence notices               — /technicians, server -> client
support request notices               — both namespaces, server -> client
remote session notices                — both namespaces, server -> client
WebRTC signaling relay                — both namespaces, bidirectional
signaling readiness                   — both namespaces, server -> client
session participation                 — tracked from remote-session:join, server-side
```

What realtime is **not** used for:

* no media. Video, audio and the WebRTC DataChannel never pass through NestJS;
* no persistence. SDP and ICE candidates are relayed and immediately forgotten;
* no state changes requested by a client. No Socket.IO message moves a
  `RemoteSession` to `ACTIVE` or closes it. Those are REST calls
  (`POST /remote-sessions/:id/activate`, `.../close`). The only server-side
  exception is the automatic close: a session whose participants stay away
  longer than the grace period, or that never reaches `ACTIVE`, is closed by the
  backend with `endedBy: "SYSTEM"` — see
  [Remote session lifecycle](#remote-session-lifecycle-automatic-close);
* no technician presence. `/technicians` keeps no registry of connected users,
  and no REST field exposes whether a technician is connected. The backend only
  tracks which sockets are *joined to a session*, and that is not exposed
  either.

### CORS

CORS for Socket.IO is configured on the **server**, not per namespace, from
`SOCKET_IO_CORS_ORIGINS` (falling back to `CORS_ORIGINS`, and then to a local
development list). It matters for `remote_control_web`, which is a browser. The
Android client is not a browser and is unaffected.

### Identity is never taken from a payload

For both namespaces the identity of the connection comes **only** from the token
validated during the handshake. A `deviceId`, `publicId`, `deviceSecret`,
`userId`, `technicianId`, `email` or `roles` sent by the client in a handshake
field or in an event payload authenticates nothing and is not read.

---

# Namespace /devices

```text
Consumer:
remote_control_device
```

## Connection

```text
URL       ws(s)://<host>:<port>/devices
Handshake auth.token = <Device JWT>
```

The token is the one returned by `POST /device-auth/login`. Only
`handshake.auth.token` is read; nothing else in the handshake is inspected.

The checks applied are the same ones `@DeviceAuth()` applies over HTTP: signature
and expiry, `tokenType: "device"`, the device exists and is `isActive`, and the
credential referenced by the token is still the active one for that device.

On success the socket is joined by the server to the device's private room and
receives `device:connected`.

Authentication runs as a namespace middleware, so a rejected connection is never
established at all: the client gets a `connect_error` and no socket, room or
presence exists for it on the server.

## Handshake errors

Every refused handshake carries a stable code in `data.code`:

```text
data.code                  message               meaning
DEVICE_AUTH_UNAUTHORIZED   Unauthorized          the backend checked the token and refused it
DEVICE_AUTH_UNAVAILABLE    Service unavailable   the backend could not finish checking the token
```

Clients branch on `data.code`. The `message` strings are fixed as shown (the
first one is kept for older clients, see
[Compatibility](#compatibility-with-earlier-clients)), but a client that knows
the codes should not need them.

Both codes **refuse** the handshake. Telling them apart never lets a socket open
without a confirmed authentication.

### Wire format

The error travels in the standard Socket.IO `CONNECT_ERROR` packet. No custom
event is used. These are the exact frames the server sends:

```text
44/devices,{"message":"Unauthorized","data":{"code":"DEVICE_AUTH_UNAUTHORIZED"}}
44/devices,{"message":"Service unavailable","data":{"code":"DEVICE_AUTH_UNAVAILABLE"}}
```

(`4` Engine.IO message, `4` Socket.IO `CONNECT_ERROR`, then the namespace and the
JSON body.) Only `message` and `data` cross the wire: no error name, no stack, no
reason, no SQL, no host, nothing from the handshake.

This shape is the one of Socket.IO protocol v5, the only protocol this server
accepts (`allowEIO3` is not enabled). What the client libraries hand to the
application:

```text
socket.io-client (JS) 4.x      connect_error(err)
                               err.message === "Unauthorized" | "Service unavailable"
                               err.data    === { code: "DEVICE_AUTH_..." }

socket_io_client (Dart) 3.1.6  onConnectError(data)
                               data is Map<String, dynamic>:
                               {"message": "...", "data": {"code": "DEVICE_AUTH_..."}}
```

Both were verified against this server. In both, a namespace refusal destroys
the client socket: the package does **not** retry it by itself
(`socket.active == false`). The application decides when to connect again.

### DEVICE_AUTH_UNAUTHORIZED

The backend examined the token and does not accept it now. Any of these, and
the client cannot tell which:

```text
no token, an empty token, or a token that is not a string
a malformed token, a bad signature (a User JWT included), an expired token
tokenType other than "device"
the device does not exist
the device is not isActive
the credential in the token is revoked, or replaced by a re-enrollment
```

Signature and expiry are checked before the database is touched, so a forged,
malformed or expired token is answered `DEVICE_AUTH_UNAUTHORIZED` even while the
database is down.

It is a statement about this **Device JWT**, not about the permanent credential.
It never proves the credential is gone: the client renews the token through
`POST /device-auth/login`, and only a `401` from there with
`code: DEVICE_CREDENTIAL_REJECTED` confirms it (see
[ENDPOINTS.md](ENDPOINTS.md#post-device-authlogin)).

### DEVICE_AUTH_UNAVAILABLE

The token passed the signature, expiry and `tokenType` checks, but the backend
could not read the device or its credential:

```text
PostgreSQL refuses the connection or is unreachable
the connection pool times out
a query fails (QueryFailedError), a statement timeout included
any other driver exception
any unexpected error inside the authentication step
```

It says nothing about the token. The handshake is still refused, exactly like a
rejection: no socket, no room, no presence, no `device:presence-updated`.

The same token may be accepted as soon as the infrastructure is back. Renewing
it does not help: `POST /device-auth/login` depends on the same database and
would answer `500` (never `DEVICE_CREDENTIAL_REJECTED`) for as long as it is
down. The intended client behaviour is to connect again **with the same token**
after a backoff, and to renew only if a later attempt answers
`DEVICE_AUTH_UNAUTHORIZED`.

The server logs a warning per occurrence with the error type and driver code
only (for example `Error ECONNREFUSED`, `QueryFailedError 42P01`), never the
error message, the token or anything else from the handshake. Rejections are not
logged.

### Compatibility with earlier clients

```text
Before   every refusal          message "Unauthorized", no data
Now      DEVICE_AUTH_UNAUTHORIZED  message "Unauthorized",        data.code
         DEVICE_AUTH_UNAVAILABLE   message "Service unavailable", data.code
```

* A genuine rejection keeps the exact message `Unauthorized`. A client that
  compares `message == "Unauthorized"` keeps treating it as before.
* An infrastructure failure, which used to arrive as `Unauthorized`, now arrives
  as `Service unavailable`. A client that only knows the old message sees a
  namespace refusal with an unknown message.
* A client that ignores `data` is unaffected by its presence.

`remote_control_device` at the time of this change (main `302fdbf`, Socket.IO
recovery of Prompt 35) classifies them as follows, verified with its real
`SocketIoDeviceRealtimeClient` and its isolated harness against this backend:

```text
DEVICE_AUTH_UNAUTHORIZED  -> RealtimeHandshakeRejected
DEVICE_AUTH_UNAVAILABLE   -> RealtimeConnectFailed(transportRetrying: false)
```

That client handles both signals with the same recovery: it releases the socket
and renews the Device JWT through `POST /device-auth/login` (the first time at
once, then on its 15 s / 30 s / 60 s backoff). So for that client the observable
behaviour does **not** change: during a database outage it still renews, the
login answers `500`, which it does not treat as a revocation, and it keeps its
enrollment and reconnects when the database is back. Skipping that unnecessary
renewal requires the client to read `data.code`; this backend change alone does
not achieve it.

### Limitations

* **A database that hangs without failing produces no `connect_error`.** The
  middleware waits for the driver. If the driver gives up first (connection
  refused, a pool timeout), the answer is `DEVICE_AUTH_UNAVAILABLE`. If it does
  not, Socket.IO closes the connection once its `connectTimeout` (45 s by
  default) expires with no namespace joined, and the client sees a transport
  close, which the client package retries with the same token. No pool or
  statement timeout is configured in this backend today.
* **The classification depends on the authentication step.** Only an
  `UnauthorizedException` raised by `DeviceAuthService` counts as a rejection.
  Anything else is `DEVICE_AUTH_UNAVAILABLE`, so an unexpected bug surfaces as
  "unavailable" — still refused, never accepted.
* **The code is an application signal, not a proof of origin**, like the REST
  application codes: anything able to forge the Socket.IO frames can forge it.
  Only a TLS connection with a validated certificate rules that out.
* **`/technicians` is unchanged.** Its handshake still answers the single
  message `Unauthorized`, with no `data.code`, for every failure.

## Presence

A device is `ONLINE` while it has at least one authenticated socket connected.
Presence is:

* derived from sockets, never sent by the client;
* exposed through REST as `isOnline` (`GET /devices`, support request listings,
  remote session responses);
* held in memory by a single backend instance — it is not persisted, and after a
  backend restart every device is `OFFLINE` until it reconnects;
* **not** the same thing as `isActive`, which is the persisted administrative
  state.

A device may hold more than one socket at once (this happens normally during a
reconnection, when the new socket arrives before the old one is detected as
dead). It goes `OFFLINE` when the last one closes.

Every effective transition — `OFFLINE -> ONLINE` on the first socket,
`ONLINE -> OFFLINE` when the last one goes away — is announced to the technician
consoles with [`device:presence-updated`](#devicepresence-updated) on
`/technicians`. The device itself receives nothing about its own presence.

Presence has direct REST consequences: `POST /support-requests/:id/assign` and
`POST /remote-sessions` both refuse with `409` when the device is `OFFLINE`.

## Forced disconnection

The backend closes a device's sockets immediately when its authorization is
withdrawn, instead of waiting for the Device JWT to expire:

```text
PATCH /devices/:id  with isActive: false      -> all sockets of that device closed
POST  /device-enrollment/activate (success)   -> all sockets of that device closed
```

The second case is a re-enrollment: the previous credential is revoked, so the
sockets authenticated with it are no longer authorized. The tablet reconnects
with the Device JWT obtained from its new `deviceSecret`.

If the device had at least one socket, closing them is an `ONLINE -> OFFLINE`
transition and the technicians receive exactly one `device:presence-updated`,
however many sockets were closed. If it had none, nothing is emitted.

## Events received by remote_control_device

### device:connected

```text
Direction     server -> device
Namespace     /devices
Sent by       backend, right after a successful handshake
Received by   the socket that just connected (that socket only)
ACK           none
```

Payload:

```json
{
  "deviceId": "550e8400-e29b-41d4-a716-446655440000",
  "publicId": "384-729-142"
}
```

Notes:
Confirms which device identity the backend resolved from the token. Useful for
the tablet to verify it is running with the credential it thinks it has.

### support:assigned

```text
Direction     server -> device
Namespace     /devices
Sent by       backend, on a successful POST /support-requests/:id/assign
Received by   every authenticated socket of that device
ACK           none
Precondition  the device had a WAITING request and was ONLINE
```

Payload:

```json
{
  "supportRequestId": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77",
  "technician": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "name": "Ana Torres"
  }
}
```

Notes:
The technician block carries only `id` and `name` — never the account email,
roles or any token.

Delivery is best-effort. If the tablet dropped between the presence check and the
emission, the assignment is still valid and is recovered with
`GET /support-requests/current`.

This is the tablet's cue to show the accept/reject prompt, answered over REST
(`POST /support-requests/:id/accept` or `.../reject`), not over Socket.IO.

### remote-session:created

```text
Direction     server -> device
Namespace     /devices
Sent by       backend, after POST /remote-sessions commits
Received by   every authenticated socket of that device
ACK           none
Precondition  the device accepted the support request and was ONLINE
```

Payload:

```json
{
  "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
  "supportRequestId": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77",
  "technician": {
    "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "name": "Ana Torres"
  }
}
```

Notes:
Emitted only after the transaction commits, so the session named here always
exists.

This is the tablet's cue to send `remote-session:join` with this
`remoteSessionId`.

Best-effort, as above: the session is recoverable with
`GET /device/remote-sessions/current`.

### remote-session:active

```text
Direction     server -> device
Namespace     /devices
Sent by       backend, after POST /remote-sessions/:id/activate commits
Received by   every authenticated socket of that device
ACK           none
Precondition  the session really moved CONNECTING -> ACTIVE
```

Payload:

```json
{ "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10" }
```

Notes:
The technician reports that WebRTC is connected and the `control` DataChannel is
open; the backend writes `ACTIVE` and `connectedAt` and announces it to both
ends. The same event name and the same payload reach `/technicians` — one
contract for one fact.

This is **not** signaling and `remote-session:join` is not required: it is
addressed to the device, not to the session room, so it arrives on a socket that
has only authenticated.

The payload is deliberately minimal. Treat the event as a trigger and read the
state:

```text
remote-session:active  ->  GET /device/remote-sessions/current
```

Emitted **only** on the real transition. A retried `/activate` on a session that
is already `ACTIVE` answers `200` and emits nothing, so the tablet never sees
this event twice for the same session — and must not rely on receiving it at
all: delivery is best-effort and nothing is replayed.

Emitted only after the transaction commits, so the session named here is already
`ACTIVE` in PostgreSQL. If delivery fails, the activation stands.

### remote-session:closed

```text
Direction     server -> device
Namespace     /devices
Sent by       backend, after the close commits, when the device did NOT close:
              - POST /remote-sessions/:id/close   (endedBy TECHNICIAN)
              - automatic close by the backend    (endedBy SYSTEM)
Received by   every authenticated socket of that device
ACK           none
```

Payload:

```json
{
  "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
  "endedBy": "TECHNICIAN"
}
```

`endedBy` is a `RemoteSessionEndedBy` value: `TECHNICIAN` or `SYSTEM` on this
namespace. Treat any other or unknown value the same way — the session is over.

Notes:
This event is **not** emitted into `/devices` when the device itself closes the
session through `POST /device/remote-sessions/:id/close` — the closing side
already receives the closed session in its HTTP response. That close emits the
same event into `/technicians` instead.

A `SYSTEM` close (see
[Remote session lifecycle](#remote-session-lifecycle-automatic-close)) was
requested by nobody, so it is emitted to **both** namespaces, with the same
payload.

The backend does not leave the session room on the device's behalf. The tablet
should tear down its peer connection when it receives this. Any further
`webrtc:*` it sends would be rejected with `UNAUTHORIZED`, since the session is
no longer live.

Emitted once per session, on the real transition only. The technician's close is
idempotent: a retried `POST /remote-sessions/:id/close` on a session that is
already `CLOSED` answers `200` and emits nothing, and when several closes race
only the one that performed the transition emits. See
[Idempotent close](ENDPOINTS.md#idempotent-close).

Delivery is best-effort: a tablet that is disconnected when the close happens
never sees this event. That is precisely the situation in which a `SYSTEM`
close for `DEVICE_ABSENT` occurs, so the tablet must not rely on it — after
every reconnection it re-reads `GET /device/remote-sessions/current`.

### webrtc:offer / webrtc:answer / webrtc:ice-candidate

Relayed from the technician. See [Signaling](#signaling) below; payloads and
rules are identical in both directions.

### remote-session:peer-joined

```text
Direction     server -> device
Namespace     /devices
When          the technician of the same RemoteSession joined its signaling room
              after this device had already joined
```

```json
{ "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10" }
```

Signaling readiness only. See
[Participant readiness](#participant-readiness) for the exact meaning, when it
is emitted and when it is not.

## Events sent by remote_control_device

```text
remote-session:join
webrtc:offer
webrtc:answer
webrtc:ice-candidate
```

All four are handled by the shared signaling service and are documented in
[Signaling](#signaling). There is no other event the device may send; an
unregistered event name is simply not handled and produces no ACK.

---

# Namespace /technicians

```text
Consumer:
remote_control_web
```

## Connection

```text
URL       ws(s)://<host>:<port>/technicians
Handshake auth.token = <User JWT>
```

The token is the one returned by `POST /auth/login` or `GET /auth/check-status`.
Only `handshake.auth.token` is read.

Authentication runs as a namespace middleware, so a rejected connection is never
established: the client gets a `connect_error` with the generic message
`Unauthorized`.

The checks are:

1. the same ones the HTTP strategy applies — signature and expiry, the user
   exists, and the user is `isActive`. An inactive user is rejected;
2. the user holds at least one of the namespace roles, read from the freshly
   loaded user record and not from the token:

```text
admin
tecnico
```

A user with only `user` or `sales` cannot open this namespace.

## Scope of this namespace

`/technicians` carries WebRTC signaling and five server notifications,
`device:presence-updated`, `support-request:queue-updated`,
`support-request:updated`, `remote-session:active` and `remote-session:closed`.
It keeps no presence registry of technicians and persists nothing.

Support requests produce three different events, each with its own audience:

```text
support:assigned               /devices      the device whose request was taken
support-request:updated        /technicians  the technician who owns a request
                                             that is already assigned
support-request:queue-updated  /technicians  every connected technician/admin,
                                             because the shared WAITING queue
                                             changed
```

* `support-request:queue-updated` covers the shared queue: a new `WAITING`
  request, a `WAITING` request taken by a technician (`ASSIGNED`), and a
  `WAITING` request cancelled by the device (`CANCELLED`).
* `support-request:updated` covers a request that already has an owner: the
  device accepts, rejects or cancels it from `ASSIGNED` or `ACCEPTED`.

No transition emits both events to technicians.

On connecting, the server puts the socket in two rooms: a private room derived
from the authenticated user, which is how a notification reaches that technician,
and a room shared by every authenticated socket of this namespace, which is how
the queue and device presence notifications reach all of them. Both rooms are internal: there is no
event to join or leave them, their names are not part of this contract, and
membership is a consequence of authenticating.

## Realtime is a trigger, never the state

`remote_control_web` must treat every server notification as *something changed,
go and read it*:

```text
device:presence-updated        ->  GET /devices
                                   GET /support-requests
support-request:queue-updated  ->  GET /support-requests
support-request:updated        ->  GET /support-requests
remote-session:active          ->  GET /remote-sessions/current
remote-session:closed          ->  GET /remote-sessions/current
```

Not as the state itself. The reasons are the same ones that apply to the tablet:

* delivery is best-effort. A socket that was reconnecting when the device closed
  never sees the event, and nothing is replayed;
* the event carries no session or support request object — only its id, plus
  who ended it in the case of a session close;
* REST is the source of truth. A support request transition, an activation and
  a close are committed to PostgreSQL before any event is emitted, and a device
  presence change is applied to the presence registry before its event is
  emitted, so REST is never behind the event — it can only be ahead of it.

The same rule covers the case where no event exists at all: after a page reload
the web app has no socket history, and `GET /remote-sessions/current` is what
tells it whether a session is still open.

## Ownership still applies to admins

Being `admin` gets a socket into the namespace; it grants nothing beyond that.
`remote-session:join` compares the session's `technicianId` against the
authenticated user, so an `admin` who is not the assigned technician is rejected
with `UNAUTHORIZED`, exactly like any other user. There is no supervision or
takeover mode.

## Known limitation — role and isActive are checked at connect time

Roles and `isActive` are verified when the socket is opened. If a technician's
access is withdrawn afterwards, the already-open socket stays open until it
disconnects on its own. What still protects the system in the meantime:

* their HTTP requests stop working immediately;
* closing the `RemoteSession` cuts their signaling immediately, because every
  `webrtc:*` message re-validates the session.

Force-closing a technician's sockets would require a technician presence
registry, which does not exist today. The handshake rooms used to deliver
`device:presence-updated`, `support-request:queue-updated`,
`support-request:updated`, `remote-session:active` and `remote-session:closed`
are not one: they address
sockets, they do not track who is connected, and nothing reads them back.

A consequence for the queue: a socket whose user lost the `admin`/`tecnico` role
after connecting keeps receiving `support-request:queue-updated` and
`device:presence-updated` until it disconnects. Those events carry only an id;
reading the queue or the devices still requires `GET /support-requests` or
`GET /devices`, which reject that user immediately.

## Events received by remote_control_web

### support-request:queue-updated

```text
Direction     server -> technicians/admins
Namespace     /technicians
Scope         shared support queue (WAITING requests)
Sent by       backend, after one of these transitions commits:
                POST /support-requests              (device)      new request -> WAITING
                POST /support-requests/:id/assign   (technician)  WAITING -> ASSIGNED
                POST /support-requests/:id/cancel   (device)      WAITING -> CANCELLED
Received by   every authenticated socket of /technicians (roles admin, tecnico)
ACK           none
Precondition  the request really entered or left WAITING
```

Payload:

```json
{ "supportRequestId": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77" }
```

Notes:
A trigger only: *the queue visible to technicians changed, read it again*.
Answer it with:

```text
support-request:queue-updated  ->  GET /support-requests
```

and let the REST response decide what the UI shows: a new `WAITING` request
appears, an `ASSIGNED` or `CANCELLED` one leaves the waiting list.

* It does **not** contain the status, the device, the technician, timestamps or
  any other field. Never infer the new state from the event; read it.
* It is **not** the source of truth. REST is.
* It does **not** require a `RemoteSession` and `remote-session:join` is **not**
  required. It arrives as soon as the socket is authenticated.
* It reaches **every** socket authenticated in `/technicians` — every
  technician and every admin, not only the one involved. Only users holding
  `admin` or `tecnico` can open this namespace, so a user with only `user` or
  `sales`, an unauthenticated socket and a device never receive it.
* Every tab receives it. A user with two open tabs gets one event per tab; the
  server does not deduplicate per user.
* The technician who assigned the request receives it too, alongside the HTTP
  response of its own `POST /support-requests/:id/assign`. Re-reading the list is
  harmless and reconciles that tab.
* On an assignment the device receives `support:assigned` on `/devices` as well.
  They are two different events for two different audiences; neither replaces
  the other.

Not emitted for transitions of a request that already has an owner —
`ASSIGNED -> ACCEPTED`, `ASSIGNED -> REJECTED`, `ASSIGNED | ACCEPTED -> CANCELLED`.
Those use `support-request:updated`, addressed only to the owner.

Emitted only on a real transition. A create, assign or cancel that answers
`409` or `404` emits nothing, so repeating a cancel does not emit twice, and when
two technicians assign the same request at the same time only the winner's
assignment emits.

Emitted only after the change is committed, so `GET /support-requests` already
reflects it. If delivery fails, the transition stands and the REST call still
returns its normal response (`201` for the create, `200` for assign and cancel) —
realtime never rolls back persisted state. Delivery is best-effort and nothing is
replayed: a console that was disconnected re-reads `GET /support-requests` after
reconnecting.

### device:presence-updated

```text
Direction     server -> technicians/admins
Namespace     /technicians
Scope         realtime presence (isOnline) of one device
Sent by       backend, when the device's effective presence changes:
                OFFLINE -> ONLINE   its first authenticated /devices socket
                                    is registered
                ONLINE  -> OFFLINE  its last socket goes away: the tablet
                                    disconnects, or the backend force-closes
                                    its sockets (PATCH /devices/:id with
                                    isActive: false, successful
                                    POST /device-enrollment/activate)
Received by   every authenticated socket of /technicians (roles admin, tecnico)
ACK           none
```

Payload:

```json
{ "deviceId": "550e8400-e29b-41d4-a716-446655440000" }
```

`deviceId` is the device's internal id — the `id` of `GET /devices` and the
`device.id` of `GET /support-requests`. The payload has no other field: not the
new state, not the `publicId`, no socket ids, no tokens or credentials.

Notes:
A cache-invalidation trigger only: *the presence of this device changed, read it
again*. It is not a snapshot. Answer it with:

```text
device:presence-updated  ->  GET /devices
                             GET /support-requests
```

The first gives `isOnline` of the device; the second gives `device.isOnline` of
every support request row of that device. Re-read whichever of the two the
console is showing (or both); the `deviceId` tells it which rows are affected.

* It does **not** say whether the device is now `ONLINE` or `OFFLINE`. Never
  infer the state from the event, and never toggle a local flag on receipt; read
  it. Two quick transitions produce two events, and only REST tells which one
  is current.
* It is **not** the source of truth. REST is. The presence registry is updated
  before the event is emitted, so a `GET` issued on receipt already returns the
  new state (or a newer one).
* It does **not** require a `RemoteSession` and `remote-session:join` is **not**
  required. It arrives as soon as the socket is authenticated.
* It reaches **every** socket authenticated in `/technicians` — every technician
  and every admin, through the same shared room as
  `support-request:queue-updated`. A user with only `user` or `sales`, an
  unauthenticated socket and a device never receive it.
* Every tab receives it; the server does not deduplicate per user.
* It is not a support request event and does not replace any: a device going
  `OFFLINE` emits no `support-request:queue-updated` or `support-request:updated`,
  and a support request transition emits no `device:presence-updated`.

Emitted only on an **effective** transition, once per transition:

```text
0 sockets -> 1 socket                    one event (ONLINE)
1 socket  -> 2 sockets                   nothing (already ONLINE)
2 sockets -> 1 socket                    nothing (still ONLINE)
1 socket  -> 0 sockets                   one event (OFFLINE)
a socket that is no longer registered    nothing
  disconnects (repeated or late
  disconnect)
forced close of N sockets                one event (OFFLINE), not N
forced close of a device already         nothing
  OFFLINE
```

Reconnections: during a reconnection the new socket often arrives before the old
one is detected as dead. While either of them is registered the device stays
`ONLINE`, so the late disconnect of the old socket emits nothing — there is no
false `OFFLINE`, and the new socket emits no second `ONLINE`. A reconnection
produces events only when the old socket was dropped before the new one arrived:
one `OFFLINE` followed by one `ONLINE`.

Re-enrollment: a successful activation emits one `OFFLINE` (if the device had
sockets); when the tablet reconnects with its new credential it emits one
`ONLINE`. A socket whose handshake is rejected (revoked credential, deactivated
device, bad token) is never registered and emits nothing.

Each event concerns exactly one device. A change on device A never emits an event
for device B.

Delivery is best-effort and nothing is replayed. If delivery fails, the presence
change stands — the tablet stays connected, or stays disconnected — and REST
still reflects it. A console that was disconnected re-reads `GET /devices` and
`GET /support-requests` after reconnecting.

Presence is held in memory by a single backend instance (see
[Presence](#presence)); with more than one instance, this event would only
reflect the sockets of the instance that emits it.

### support-request:updated

```text
Direction     server -> technician
Namespace     /technicians
Sent by       backend, after the device's transition commits:
                POST /support-requests/:id/accept   ASSIGNED -> ACCEPTED
                POST /support-requests/:id/reject   ASSIGNED -> REJECTED
                POST /support-requests/:id/cancel   ASSIGNED | ACCEPTED -> CANCELLED
Received by   every authenticated socket of the technician assigned to the request
ACK           none
Precondition  the request really changed state and has an assigned technician
```

Payload:

```json
{ "supportRequestId": "8f14e45f-ceea-4d3c-b4e2-2f4b3c9a1d77" }
```

Notes:
A trigger only: *this support request changed, read it again*. Answer it with:

```text
support-request:updated  ->  GET /support-requests
```

* It does **not** contain the status, the device, the technician, timestamps or
  any other field. Never infer the new state from the event; read it.
* It is **not** the source of truth. REST is.
* It does **not** require a `RemoteSession` — usually none exists yet when it is
  emitted — and `remote-session:join` is **not** required. It is a support
  request domain notification addressed to the technician, not signaling.

It reaches only the technician whose id is stored on the request. The recipient
comes from the persisted request, never from anything the device sends. Another
technician, and an `admin` who is not the assigned technician, receive nothing.

A cancellation of a request that is still `WAITING` does not emit this event: it
has no technician to address. It emits `support-request:queue-updated` instead.

Emitted only on a real transition. Repeating accept, reject or cancel on a
request that already left that state answers `409` and emits nothing.

Emitted only after the change is committed. If delivery fails, the transition
stands and the device still receives its normal `200` — realtime never rolls
back persisted state. Delivery is best-effort and nothing is replayed.

### remote-session:active

```text
Direction     server -> technician
Namespace     /technicians
Sent by       backend, after POST /remote-sessions/:id/activate commits
Received by   every authenticated socket of the technician who owns the session
ACK           none
Precondition  the session really moved CONNECTING -> ACTIVE
```

Payload:

```json
{ "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10" }
```

Notes:
Same event name and same payload as the one `/devices` receives. The web app
gets it even though it is the side that called `/activate`: this is not an echo
of an HTTP response but the confirmation of a committed state change, and it
also reaches the technician's other tabs.

`remote-session:join` is **not** required — it is a domain notification
addressed to the technician, not to the session room.

Answer it by reading the state, never by taking the event as the state:

```text
remote-session:active  ->  GET /remote-sessions/current
```

It reaches only the technician the session belongs to; another connected
technician receives nothing.

Emitted only on the real transition: a retried `/activate` on an `ACTIVE`
session emits nothing. Emitted only after the transaction commits, and if
delivery fails the activation stands — realtime never rolls back persisted
state.

### remote-session:closed

```text
Direction     server -> technician
Namespace     /technicians
Sent by       backend, after the close commits, when the technician did NOT close:
              - POST /device/remote-sessions/:id/close   (endedBy DEVICE)
              - automatic close by the backend           (endedBy SYSTEM)
Received by   every authenticated socket of the technician who owns the session
ACK           none
```

Payload:

```json
{
  "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
  "endedBy": "DEVICE"
}
```

Same event name and same payload as the one `/devices` receives — one contract
for one fact. `endedBy` is a `RemoteSessionEndedBy` value: `DEVICE` or `SYSTEM`
here, because those are the closes the technician did not perform. Treat any
other or unknown value the same way — the session is over.

A `SYSTEM` close reaches every socket of the owning technician, including tabs
that never joined the session. See
[Remote session lifecycle](#remote-session-lifecycle-automatic-close).

Notes:
`remote-session:join` is **not** required. This is a domain notification, not
signaling: it is addressed to the technician, not to the session room, so it
arrives on a socket that has only authenticated.

It reaches only the technician the session belongs to. There is no broadcast, and
another connected technician receives nothing.

It is **not** emitted when the technician closes the session with
`POST /remote-sessions/:id/close` — that HTTP response already carries the closed
session.

Emitted once per session, on the real transition only. The device's close is
idempotent: a retried `POST /device/remote-sessions/:id/close` on a session that
is already `CLOSED` answers `200` and emits nothing, and when several closes race
only the one that performed the transition emits. A client must therefore not
wait for this event to confirm its own close: the HTTP response is the
confirmation. See [Idempotent close](ENDPOINTS.md#idempotent-close).

Emitted only after the transaction commits, so the session named here is always
already `CLOSED` and its support request `COMPLETED`. If the delivery fails, the
close stands: realtime never rolls back persisted state.

Answer it with `GET /remote-sessions/current`, and tear down the peer connection.
Any further `webrtc:*` for that session would be rejected with `UNAUTHORIZED`.

### webrtc:offer / webrtc:answer / webrtc:ice-candidate

```text
webrtc:offer
webrtc:answer
webrtc:ice-candidate
```

Relayed from the device. See [Signaling](#signaling).

### remote-session:peer-joined

```text
Direction     server -> technician
Namespace     /technicians
When          the device of the same RemoteSession joined its signaling room
              after this technician had already joined
```

```json
{ "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10" }
```

Signaling readiness only. See
[Participant readiness](#participant-readiness) for the exact meaning, when it
is emitted and when it is not.

## Events sent by remote_control_web

```text
remote-session:join
webrtc:offer
webrtc:answer
webrtc:ice-candidate
```

See [Signaling](#signaling).

---

# Signaling

Both namespaces expose the same four inbound events, handled by the same
service. The only difference is which identity the gateway attaches to the
message (`DEVICE` or `TECHNICIAN`) and, consequently, which namespace the relay
goes out to.

```text
The backend only relays signaling.
SDP and ICE are not persisted.
Media/video does not pass through NestJS.
```

The backend is also **direction-neutral**: it does not decide which side creates
the offer. Either end may send `webrtc:offer`; the clients agree on that between
themselves.

Nothing in signaling changes the `RemoteSession` row. In particular, exchanging
SDP does **not** move a session from `CONNECTING` to `ACTIVE`.

The SDP and the ICE candidates are never written to the logs.

## remote-session:join

```text
Direction     client -> server
Namespace     /devices and /technicians
Sent by       remote_control_device, remote_control_web
ACK           JoinRemoteSessionAck (see below)
```

Payload:

```json
{ "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10" }
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `remoteSessionId` | string | yes | UUID |

This is the only accepted property. The participant is **not** accepted from the
client — it comes from the namespace the socket connected through — and the room
name is built by the server. Any extra property makes the payload invalid.

ACK — accepted:

```json
{
  "joined": true,
  "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
  "peerJoined": false
}
```

| Field | Type | Meaning |
|---|---|---|
| `joined` | boolean | always `true` in this branch |
| `remoteSessionId` | string | the session this socket is now joined to |
| `peerJoined` | boolean | whether the **other** participant is already in the signaling room |

`peerJoined` is signaling readiness and nothing else — see
[Participant readiness](#participant-readiness).

ACK — rejected:

```json
{ "joined": false, "error": "UNAUTHORIZED" }
```

A rejected ACK carries no `peerJoined`: without a join there is no readiness to
report. Possible `error` values: `INVALID_PAYLOAD`, `UNAUTHORIZED`.

Preconditions for a successful join:

1. the payload is a valid `{ remoteSessionId }` object;
2. a `RemoteSession` with that id exists;
3. its status is **live** — `CONNECTING` or `ACTIVE`. A `CLOSED` session is
   never joinable;
4. it belongs to the caller: `deviceId` must equal the socket's device for a
   `/devices` socket, `technicianId` must equal the socket's user for a
   `/technicians` socket.

Failing 2, 3 or 4 all produce the same `UNAUTHORIZED`. Knowing a session UUID
therefore reveals nothing about whether it exists, is closed, or belongs to
someone else.

One session per socket:

A socket participates in exactly **one** remote session at a time. The server
stores the joined session on the socket, and that stored value — not the payload
— is what later authorizes `webrtc:*`.

Behaviour when joining while already joined elsewhere:

```text
payload invalid       -> INVALID_PAYLOAD; the socket KEEPS its current session
payload valid, join OK-> the socket leaves the old session and joins the new one
payload valid, denied -> the socket has ALREADY left the old session and ends up
                         with no session at all; it must join again
```

The payload is validated before anything is torn down precisely so that a
malformed message cannot knock a client out of its session.

A client that needs to work with a different session simply sends
`remote-session:join` again.

Notes:
`remote-session:join` is mandatory before any `webrtc:*` event. It is also the
event to resend after a reconnection — a fresh socket has no joined session.

Do **not** start the WebRTC negotiation on `joined: true` alone. Signaling is
never buffered, so an offer sent into an empty room is lost. Start it when
`peerJoined` is `true`, or when `remote-session:peer-joined` arrives.

## Participant readiness

```text
peerJoined                   field of the successful remote-session:join ACK
remote-session:peer-joined   server -> client event, both namespaces
```

Both answer exactly one question:

```text
Is there at least one socket of the OPPOSITE namespace
currently joined to this RemoteSession?
```

For a `/technicians` socket the opposite side is the **device**; for a
`/devices` socket it is the **technician**.

What it does **not** mean:

```text
NOT "WebRTC is connected"
NOT "ICE finished"
NOT "the session is ACTIVE"
NOT "video is available"
NOT "the device is ONLINE"
```

It is readiness for *signaling*: the peer is in the room, so a message sent now
has somebody to reach.

Why it exists:

```text
technician joins  -> joined: true
technician sends webrtc:offer
device has not joined yet
-> the offer is dropped and never replayed
```

The ACK alone cannot rule that out, because it only proves *this* socket
joined. `peerJoined` closes the race without clients resorting to arbitrary
delays.

### Join order

Technician first:

```text
technician  remote-session:join  -> { joined: true, ..., peerJoined: false }
                                    no event is emitted to anybody
device      remote-session:join  -> { joined: true, ..., peerJoined: true }
technician  receives                remote-session:peer-joined
```

Device first is symmetric:

```text
device      remote-session:join  -> { joined: true, ..., peerJoined: false }
technician  remote-session:join  -> { joined: true, ..., peerJoined: true }
device      receives                remote-session:peer-joined
```

The side that arrives second learns it from its own ACK and receives no event —
the event exists only for the side that was already waiting.

### Payload

```json
{ "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10" }
```

That is the whole payload. It never carries `userId`, `technicianId`,
`deviceId`, a token, a socket id or a count of connections. Clients already know
who the other end of their session is; the event only says *when*.

### Rules a client can rely on

* **Authorization first.** Readiness is computed only after the join passed all
  its checks. A socket rejected with `UNAUTHORIZED` never turns another
  participant's `peerJoined` into `true` and never triggers the event;
* **Session isolation.** Only participants of the *same* `RemoteSession` are
  ever observed. Two sessions running at once never see each other, not even
  when the same technician owns both;
* **Nothing is persisted.** Readiness is live room membership. After a
  disconnection the socket is gone from the room, so a peer that joins next gets
  `peerJoined: false`;
* **Reconnection recomputes it.** A client that reconnects and re-sends
  `remote-session:join` gets a freshly computed `peerJoined`, and the waiting
  peer receives `remote-session:peer-joined` again;
* **Treat the event as idempotent.** It can arrive more than once for the same
  session — a reconnect, or both ends joining simultaneously. Receiving it when
  the peer is already known must be harmless;
* **One logical participant per side.** A technician may hold several sockets
  (several browser tabs). `peerJoined` means *at least one* opposite socket, and
  the count of sockets is never exposed. A second tab joining a session whose
  technician side is already present does not re-notify the device; when the
  event is emitted, every socket of the receiving side gets it, since it is sent
  to the session room.

There is no `remote-session:peer-left` today. A peer that goes away is detected
through the WebRTC/ICE connection state once WebRTC is in place, and through
`remote-session:closed` when the session ends — including the automatic
`SYSTEM` close when that peer stays away longer than the grace period.

The same room membership has a second use: it is how the backend knows that a
participant is still *taking part* in the session. See
[Remote session lifecycle](#remote-session-lifecycle-automatic-close).

## webrtc:offer

```text
Direction     client -> server -> peer client
Namespace     /devices and /technicians
Sent by       remote_control_device or remote_control_web
Received by   the other end of the same RemoteSession, in the OTHER namespace
ACK           SignalingRelayAck (see below)
```

Payload sent by the client:

```json
{
  "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
  "sdp": "v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\n..."
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `remoteSessionId` | string | yes | UUID |
| `sdp` | string | yes | 1–32768 characters |

Payload delivered to the peer:

```json
{
  "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
  "from": "DEVICE",
  "sdp": "v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\n..."
}
```

`from` is added by the server and is `DEVICE` or `TECHNICIAN`. Only the validated
fields are forwarded — the object received from the sender is never passed
through, so nothing extra can ride along.

## webrtc:answer

Identical to `webrtc:offer` in payload, constraints, relayed shape and ACK. Only
the event name differs; the backend does not interpret the SDP, and the offer /
answer distinction lives entirely in the event name.

## webrtc:ice-candidate

```text
Direction     client -> server -> peer client
Namespace     /devices and /technicians
Sent by       remote_control_device or remote_control_web
Received by   the other end of the same RemoteSession, in the OTHER namespace
ACK           SignalingRelayAck (see below)
```

Payload sent by the client:

```json
{
  "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
  "candidate": "candidate:842163049 1 udp 1677729535 192.0.2.10 54321 typ srflx",
  "sdpMid": "0",
  "sdpMLineIndex": 0
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `remoteSessionId` | string | yes | UUID |
| `candidate` | string | yes | max 1024 characters; the empty string is allowed |
| `sdpMid` | string \| null | no | max 64 characters |
| `sdpMLineIndex` | integer \| null | no | 0–255 |

`sdpMid` and `sdpMLineIndex` may be omitted or sent explicitly as `null`, because
real WebRTC implementations produce them that way. The empty `candidate` string
is accepted since some implementations use it to signal end-of-candidates.

Payload delivered to the peer:

```json
{
  "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10",
  "from": "TECHNICIAN",
  "candidate": "candidate:842163049 1 udp 1677729535 192.0.2.10 54321 typ srflx",
  "sdpMid": "0",
  "sdpMLineIndex": 0
}
```

Omitted optional fields are normalized to `null` on the way out, so the receiver
always gets both keys.

Notes:
The backend validates types and sizes but does not parse or interpret the
candidate.

## Relay ACK

Every `webrtc:*` event answers with:

Accepted:

```json
{ "delivered": true, "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10" }
```

Rejected:

```json
{ "delivered": false, "error": "NOT_JOINED" }
```

Possible `error` values: `INVALID_PAYLOAD`, `NOT_JOINED`, `UNAUTHORIZED`,
`UNAVAILABLE`.

`delivered: true` means the message was handed to the peer's namespace — **not**
that anybody received it. If the other end has not joined the session yet, the
room is empty and the message is silently dropped. Signaling is ephemeral by
design and is never buffered or retried.

## Per-message re-validation

A `webrtc:*` message is authorized on every single delivery, not once at join
time:

1. the session id in the payload must equal the session stored on the socket by
   a previous successful `remote-session:join` → otherwise `NOT_JOINED`;
2. the session must still exist, still be live (`CONNECTING` / `ACTIVE`), and
   still belong to the caller → otherwise `UNAUTHORIZED`.

So closing a `RemoteSession` over REST cuts signaling immediately: subsequent
messages start answering `UNAUTHORIZED` without any extra step.

## Signaling error codes

```text
INVALID_PAYLOAD  The payload does not satisfy the DTO: a field is missing, has
                 the wrong type, exceeds a size limit, or an unknown property
                 was included. The payload is not an object, or is an array.

NOT_JOINED       The socket has not joined that RemoteSession, or it is joined
                 to a different one. Knowing a valid session UUID is not enough.
                 Fix: send remote-session:join first.

UNAUTHORIZED     The session does not exist, is CLOSED, or belongs to another
                 device/technician. The three cases are indistinguishable on
                 purpose. Also returned if the socket somehow carries no
                 identity.

UNAVAILABLE      The destination namespace is not registered in the server yet,
                 so the message could not be handed over. A transient
                 server-side condition, not a client error.
```

These codes are the stable part of the contract — clients must branch on
`error`, never on a human-readable string.

Handlers always answer their ACK, including on rejection: a client waiting on an
acknowledgement never hangs.

---

# Rooms

Four rooms exist. All of them are **assigned by the server**; a client never
names, requests or constructs a room.

```text
device:<deviceId>                 internal. Namespace /devices only.
                                  Joined automatically at handshake, from the
                                  deviceId in the validated token. It is how the
                                  backend addresses a specific tablet
                                  (support:assigned, remote-session:created,
                                  remote-session:active, remote-session:closed).

<per-technician room>             internal. Namespace /technicians only.
                                  Joined automatically at handshake, from the
                                  user id in the validated token. It is how the
                                  backend addresses a specific technician
                                  (support-request:updated,
                                  remote-session:active,
                                  remote-session:closed). Its name is not part
                                  of this contract and may change.

<all-technicians room>            internal. Namespace /technicians only.
                                  Every socket joins it automatically at
                                  handshake, after its token and role were
                                  validated. It is how the backend addresses
                                  every technician and admin at once
                                  (support-request:queue-updated,
                                  device:presence-updated). It is not
                                  related to the per-technician rooms nor to
                                  any remote-session room. Its name is not part
                                  of this contract and may change.

remote-session:<remoteSessionId>  joined by the server as the result of a
                                  successful remote-session:join, in the
                                  namespace the socket belongs to. It is how a
                                  signaling message reaches the other end, and
                                  what remote-session:peer-joined is computed
                                  from and emitted to.
```

Points that matter for the Flutter clients:

* the client does **not** choose the room it is put in at handshake, and there
  is no event to join or leave a room directly. Room membership is a consequence
  of authenticating and of `remote-session:join`;
* the handshake rooms carry domain notifications, the session room carries
  signaling. That is why `device:presence-updated`,
  `support-request:queue-updated`, `support-request:updated`,
  `remote-session:active` and `remote-session:closed` arrive without having
  joined anything, while a `webrtc:*` message does not;
* membership of the session room is also the whole implementation of readiness:
  `peerJoined` and `remote-session:peer-joined` are answers about who is in
  `remote-session:<id>` in the *other* namespace, and nothing is stored;
* the same membership is what the automatic close calls *participation*: a side
  with no socket in the session room for longer than the grace period gets its
  `ACTIVE` session closed with `endedBy: "SYSTEM"`;
* `/devices` and `/technicians` are separate namespaces with **separate rooms**.
  `remote-session:<id>` in `/devices` and `remote-session:<id>` in
  `/technicians` are two different rooms that merely share a name. Relaying "to
  the peer" means emitting to the same room name in the *other* namespace;
* because of that split, a sender never receives its own relayed message: its
  socket lives in the origin namespace and the emission targets the destination
  one;
* there is no namespace-wide broadcast anywhere in the realtime layer. Every
  emission targets one specific room; the widest one is the all-technicians
  room, which only holds sockets authenticated as `admin` or `tecnico`.

---

# Reconnection

```text
Socket.IO disconnect does not close a RemoteSession immediately.
It starts a grace period if it was the last socket of that side in the session.
Rejoining the session (remote-session:join) within the grace period keeps it.
After reconnecting, the client must authenticate again through the handshake.
For signaling AND for keeping the session alive, the client must join again.
```

Details that apply to the current implementation:

* **Domain state survives a short disconnection.** A `RemoteSession` keeps its
  status while a side is away for less than the grace period
  (`REMOTE_SESSION_DISCONNECT_GRACE_MS`, 60 s by default). If the side does not
  rejoin in time, the session is closed with `endedBy: "SYSTEM"` and its
  `SupportRequest` becomes `COMPLETED` — see
  [Remote session lifecycle](#remote-session-lifecycle-automatic-close). A
  disconnection never changes a `SupportRequest` by itself. Losing the Socket.IO
  connection does not mean the WebRTC connection is gone, and the backend does
  not infer anything about WebRTC; what it closes is the *authorization*.
* **Reconnecting is not enough: rejoin.** A freshly connected socket that has not
  sent `remote-session:join` does not count as taking part in the session and
  does not stop the grace period.
* **The handshake must carry a valid token again.** The Socket.IO client
  resends `auth` on each reconnection attempt, so a client holding an expired
  Device JWT must refresh it (`POST /device-auth/login`) before reconnecting, or
  every attempt fails with `connect_error` `DEVICE_AUTH_UNAUTHORIZED`. A
  `DEVICE_AUTH_UNAVAILABLE` refusal is different: the token may still be good,
  and the same token can be presented again once the backend recovers — see
  [Handshake errors](#handshake-errors). Neither refusal is retried by the
  client package itself: after a namespace refusal the application has to call
  `connect` again.
* **Joined sessions do not survive.** A new socket has no session attached, so
  `webrtc:*` would answer `NOT_JOINED`. Send `remote-session:join` again after
  every reconnection.
* **Readiness is not persisted either.** The reconnected socket is out of the
  session room until it joins again, so during that gap the peer's next join
  reports `peerJoined: false`. Once it re-joins, its ACK carries the recomputed
  value and the waiting peer receives `remote-session:peer-joined` again.
* **Events sent while disconnected are lost.** There is no buffering or replay.
  After reconnecting, the client re-reads state over REST:

```text
remote_control_device   GET /support-requests/current
                        GET /device/remote-sessions/current

remote_control_web      GET /devices
                        GET /support-requests
                        GET /remote-sessions/current
```

* **Presence may briefly show two sockets.** A device can hold the old and the
  new socket at the same time; it reads `ONLINE` throughout, and both sockets
  receive the device-addressed events until the stale one closes. The
  technicians receive no `device:presence-updated` for this overlap, because the
  effective presence never changed.
* **A forced disconnection is not a transient failure.** If the backend closed
  the socket because the device was deactivated or re-enrolled, reconnecting
  with the same token fails: the tablet needs a new `deviceSecret` (re-enroll)
  or an administrator has to re-enable the device. A live session of that
  device therefore ends with `SYSTEM` once the grace period expires.

---

# Remote session lifecycle (automatic close)

The backend closes remote sessions that nobody is taking part in any more, and
sessions that never got connected. Such a close is recorded with
`endedBy: "SYSTEM"`. It is the only state change the backend makes on its own.

```text
ACTIVE  ->  a side loses its last joined socket  ->  grace period
              ├── that side rejoins in time      ->  stays ACTIVE
              └── it does not                    ->  CLOSED, endedBy SYSTEM
                                                     SupportRequest COMPLETED
                                                     remote-session:closed to BOTH ends

CONNECTING  ->  createdAt + TTL reached without ACTIVE  ->  CLOSED, endedBy SYSTEM
```

## Participant

A side (device or technician) **takes part** in a session while it has at least
one authenticated socket joined to that session through a successful
`remote-session:join` — the same room membership that drives readiness. It is
evaluated per backend instance, from the server side only.

```text
Counts                                       Does not count
-------------------------------------------  -------------------------------------------
a socket joined to the session room          a socket that only authenticated
  (validated: live session, owned by caller)   (console open, tablet ONLINE)
any one of several tabs / sockets            a WebRTC peer connection: the backend relays
                                               signaling and cannot see WebRTC, so it
                                               never pretends to
```

Consequences:

* several sockets on one side (two browser tabs, or the old and new socket of a
  reconnecting tablet) count as one participant: the side is absent only when
  the **last** joined socket goes away;
* a socket can only remove itself. The late disconnect of an old socket cannot
  make a side absent while a newer socket is joined, and cannot cancel anything;
* nothing a client sends declares it "alive": there is no heartbeat event. The
  only thing that ends a grace period is a `remote-session:join` that passes
  every check (session exists, is live, belongs to the authenticated identity).
  A join to a `CLOSED` session is rejected and never reopens it;
* for the device, losing its last `/devices` socket (going `OFFLINE`) always
  makes it absent, because joined sockets are a subset of presence sockets. The
  reverse is not true: a tablet that is `ONLINE` but has not rejoined is absent.
  Presence (`device:presence-updated`) is unchanged by any of this.

Both current clients already rejoin automatically after every reconnection,
including while the session is `ACTIVE`, and stay joined for the whole session.

## Timings

| Variable | Default | Meaning |
|---|---|---|
| `REMOTE_SESSION_DISCONNECT_GRACE_MS` | `60000` | How long an `ACTIVE` session survives a side with no joined socket. |
| `REMOTE_SESSION_CONNECTING_TTL_MS` | `120000` | Maximum life of a `CONNECTING` session, counted from `createdAt`. |
| `REMOTE_SESSION_STARTUP_RECOVERY_MS` | `90000` | After the backend starts, no session is closed before this window ends. |

Integer milliseconds between `5000` and `3600000`; an invalid value prevents the
backend from starting. These are server settings, not part of any payload.

Why these defaults (they are starting values, to be confirmed by the physical
validation):

* **Grace 60 s.** With Socket.IO defaults (`pingInterval` 25 s, `pingTimeout`
  20 s) the server notices a connection that died without a clean close up to
  ~45 s after the network dropped; the grace starts there. The clients retry
  with `reconnectionDelayMax` 10 s (web) and 20 s (tablet), so 60 s covers
  several reconnection attempts plus the automatic rejoin. Worst case from
  network loss to close is therefore about 45 s + 60 s.
* **TTL 120 s.** Covers `remote-session:created` reaching the tablet, the user
  accepting Android's screen-capture dialog, SDP/ICE negotiation and the
  technician's `/activate`. A healthy negotiation takes seconds.
* **Startup recovery 90 s.** After a restart the participation registry is
  empty; this is the grace plus a margin for clients that are retrying at their
  maximum delay.

## CONNECTING TTL

A `CONNECTING` session is closed at `createdAt + REMOTE_SESSION_CONNECTING_TTL_MS`
whatever happens meanwhile — no SDP, no ICE, a side that never joined, a failed
negotiation, or an `/activate` that never arrives. Signaling traffic does **not**
renew it. If the session became `ACTIVE` first, the TTL no longer applies; if it
closed first, nothing happens. The participation rule above applies only to
`ACTIVE` sessions; a `CONNECTING` session is governed by its TTL alone.

An `/activate` that arrives after the TTL close answers `409`, like any other
`CLOSED` session.

## The SYSTEM close

It is the same transition as the technician and device closes — one transaction
that moves the session to `CLOSED` (`endedAt`, `endedBy: "SYSTEM"`) and the
support request to `COMPLETED`. Before writing, the backend locks the session
row and re-evaluates the condition, so:

* it never closes a session that recovered, was activated, or was already closed
  in the meantime;
* if a technician or device close races with it, exactly one wins — all three
  take the same row lock; a losing technician or device close answers `200`
  with the winning close (REST, idempotent), a losing SYSTEM close does
  nothing, and the recorded `endedBy` / `endedAt` are the winner's;
* a technician or device close that arrives after the SYSTEM close (for example
  a retry queued while offline) answers `200` with `endedBy: "SYSTEM"` and the
  original `endedAt`: it neither rewrites the close nor emits again;
* a stale timer can only cause an extra read: it never touches another session.

After the commit, and only then, `remote-session:closed` is emitted to **both**
`/devices` and `/technicians` with `{ remoteSessionId, endedBy: "SYSTEM" }`.
Technician and device closes keep their existing behaviour (event only to the
side that did not close).

## Delivery limits

Delivery is best-effort. The side whose absence caused the close is, by
definition, not connected when the event is sent, and nothing is replayed. Both
clients must reconcile over REST after every reconnection:

```text
remote_control_device   GET /device/remote-sessions/current   -> null when closed
remote_control_web      GET /remote-sessions/current          -> null when closed
                        GET /remote-sessions/:id              -> CLOSED, endedBy SYSTEM
```

A `remote-session:join` for a session that was closed meanwhile answers
`UNAUTHORIZED`; treat that as a cue to re-read REST as well.

## Backend restart

Participation lives in memory and timers do not survive a restart; PostgreSQL
keeps the sessions. On start the backend reads the live sessions once and:

* closes nothing immediately;
* gives every `ACTIVE` session until the end of the recovery window for both
  sides to reconnect and rejoin; a side still absent then is closed with
  `SYSTEM`;
* closes, at the end of the window, every `CONNECTING` session whose TTL expired
  while the backend was down.

There is no periodic polling of the database: deadlines come from that startup
read, from session creation/activation/close, and from participants leaving.
A failed evaluation is retried after 15 s.

## WebRTC is not cut by this event alone

The backend does not relay media and cannot stop a peer-to-peer connection that
is already established. Closing the session revokes the *authorization*:
signaling is refused immediately (`UNAUTHORIZED`) and REST reports the session
as `CLOSED`. Actually stopping the screen capture and the control channel is the
clients' job:

* **remote_control_device** must tear down its peer connection and the capture
  when it receives `remote-session:closed`, and also when, after reconnecting,
  `GET /device/remote-sessions/current` no longer returns the session — even if
  its WebRTC link is still up;
* **remote_control_web** should re-read `GET /remote-sessions/current` after
  every reconnection and when a `remote-session:join` is refused, so a session
  closed while it was disconnected does not stay on screen.

## Limitations

* Single backend instance, like device presence: participation is per process.
  Several instances would need a shared adapter and a shared registry.
* Closing the browser tab is detected only through the socket disconnect, i.e.
  the session closes about one grace period later, not instantly.
