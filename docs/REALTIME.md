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
device presence (ONLINE/OFFLINE)      — /devices only, server-side
support request notices               — /devices only, server -> device
remote session notices                — both namespaces, server -> client
WebRTC signaling relay                — both namespaces, bidirectional
```

What realtime is **not** used for:

* no media. Video, audio and the WebRTC DataChannel never pass through NestJS;
* no persistence. SDP and ICE candidates are relayed and immediately forgotten;
* no state changes. Signaling never moves a `RemoteSession` to `ACTIVE`;
* no technician presence. `/technicians` keeps no registry of connected users,
  and no REST field exposes whether a technician is connected.

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

Authentication runs as a namespace middleware, so a rejected connection is never
established at all: the client gets a `connect_error` whose message is the single
generic string `Unauthorized`. The reason is deliberately not disclosed —
missing token, bad signature, wrong token type, expired token, unknown device,
deactivated device and revoked credential are indistinguishable to the client.

The checks applied are the same ones `@DeviceAuth()` applies over HTTP: signature
and expiry, `tokenType: "device"`, the device exists and is `isActive`, and the
credential referenced by the token is still the active one for that device.

On success the socket is joined by the server to the device's private room and
receives `device:connected`.

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

### remote-session:closed

```text
Direction     server -> device
Namespace     /devices
Sent by       backend, on a successful POST /remote-sessions/:id/close
              (the TECHNICIAN-initiated close only)
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

`endedBy` is a `RemoteSessionEndedBy` value.

Notes:
This event is **not** emitted into `/devices` when the device itself closes the
session through `POST /device/remote-sessions/:id/close` — the closing side
already receives the closed session in its HTTP response. That close emits the
same event into `/technicians` instead.

The backend does not leave the session room on the device's behalf. The tablet
should tear down its peer connection when it receives this. Any further
`webrtc:*` it sends would be rejected with `UNAUTHORIZED`, since the session is
no longer live.

### webrtc:offer / webrtc:answer / webrtc:ice-candidate

Relayed from the technician. See [Signaling](#signaling) below; payloads and
rules are identical in both directions.

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

`/technicians` carries WebRTC signaling and exactly one server notification,
`remote-session:closed`. It keeps no presence registry and persists nothing.

Everything else is still read over REST. A technician is **not** told over
Socket.IO when a device accepts, rejects or cancels a support request: that state
comes from `GET /support-requests`, polled or re-read after a user action.

On connecting, the server puts the socket in a private room derived from the
authenticated user, which is how a notification reaches that technician. The room
is internal: there is no event to join or leave it, its name is not part of this
contract, and membership is a consequence of authenticating.

## Realtime is a trigger, never the state

`remote_control_web` must treat `remote-session:closed` as *something changed,
go and read it*:

```text
remote-session:closed  ->  GET /remote-sessions/current
```

Not as the state itself. The reasons are the same ones that apply to the tablet:

* delivery is best-effort. A socket that was reconnecting when the device closed
  never sees the event, and nothing is replayed;
* the event carries no session object, only its id and who ended it;
* REST is the source of truth. A close is committed to PostgreSQL before any
  event is emitted, so REST is never behind the event — it can only be ahead of
  it.

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
registry, which does not exist today. The handshake room used to deliver
`remote-session:closed` is not one: it addresses sockets, it does not track who
is connected, and nothing reads it back.

## Events received by remote_control_web

### remote-session:closed

```text
Direction     server -> technician
Namespace     /technicians
Sent by       backend, after POST /device/remote-sessions/:id/close commits
              (the DEVICE-initiated close only)
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
for one fact. `endedBy` is a `RemoteSessionEndedBy` value and is `DEVICE` here,
because this is the close the technician did not perform.

Notes:
`remote-session:join` is **not** required. This is a domain notification, not
signaling: it is addressed to the technician, not to the session room, so it
arrives on a socket that has only authenticated.

It reaches only the technician the session belongs to. There is no broadcast, and
another connected technician receives nothing.

It is **not** emitted when the technician closes the session with
`POST /remote-sessions/:id/close` — that HTTP response already carries the closed
session.

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
{ "joined": true, "remoteSessionId": "3d1b9e64-9a0f-4c88-9d0a-6f2a5c7e8b10" }
```

ACK — rejected:

```json
{ "joined": false, "error": "UNAUTHORIZED" }
```

Possible `error` values: `INVALID_PAYLOAD`, `UNAUTHORIZED`.

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

Three rooms exist. All of them are **assigned by the server**; a client never
names, requests or constructs a room.

```text
device:<deviceId>                 internal. Namespace /devices only.
                                  Joined automatically at handshake, from the
                                  deviceId in the validated token. It is how the
                                  backend addresses a specific tablet
                                  (support:assigned, remote-session:created,
                                  remote-session:closed).

<per-technician room>             internal. Namespace /technicians only.
                                  Joined automatically at handshake, from the
                                  user id in the validated token. It is how the
                                  backend addresses a specific technician
                                  (remote-session:closed). Its name is not part
                                  of this contract and may change.

remote-session:<remoteSessionId>  joined by the server as the result of a
                                  successful remote-session:join, in the
                                  namespace the socket belongs to. It is how a
                                  signaling message reaches the other end.
```

Points that matter for the Flutter clients:

* the client does **not** choose the room it is put in at handshake, and there
  is no event to join or leave a room directly. Room membership is a consequence
  of authenticating and of `remote-session:join`;
* the two handshake rooms carry domain notifications, the session room carries
  signaling. That is why `remote-session:closed` arrives without having joined
  anything, while a `webrtc:*` message does not;
* `/devices` and `/technicians` are separate namespaces with **separate rooms**.
  `remote-session:<id>` in `/devices` and `remote-session:<id>` in
  `/technicians` are two different rooms that merely share a name. Relaying "to
  the peer" means emitting to the same room name in the *other* namespace;
* because of that split, a sender never receives its own relayed message: its
  socket lives in the origin namespace and the emission targets the destination
  one;
* there is no broadcast anywhere in the realtime layer. Every emission targets
  one specific room.

---

# Reconnection

```text
Socket.IO disconnect does not close a RemoteSession.
Socket.IO disconnect does not change a SupportRequest.
After reconnecting, the client must authenticate again through the handshake.
For signaling, the client must join the RemoteSession again.
```

Details that apply to the current implementation:

* **Domain state survives.** Disconnecting affects device presence only. A
  `RemoteSession` stays `CONNECTING` and a `SupportRequest` keeps its status; no
  timeout closes either of them today, and `RemoteSessionEndedBy.SYSTEM` is
  never written.
* **The handshake must carry a valid token again.** The Socket.IO client
  resends `auth` on each reconnection attempt, so a client holding an expired
  Device JWT must refresh it (`POST /device-auth/login`) before reconnecting, or
  every attempt fails with `connect_error: Unauthorized`.
* **Joined sessions do not survive.** A new socket has no session attached, so
  `webrtc:*` would answer `NOT_JOINED`. Send `remote-session:join` again after
  every reconnection.
* **Events sent while disconnected are lost.** There is no buffering or replay.
  After reconnecting, the client re-reads state over REST:

```text
remote_control_device   GET /support-requests/current
                        GET /device/remote-sessions/current

remote_control_web      GET /support-requests
                        GET /remote-sessions/current
```

* **Presence may briefly show two sockets.** A device can hold the old and the
  new socket at the same time; it reads `ONLINE` throughout, and both sockets
  receive the device-addressed events until the stale one closes.
* **A forced disconnection is not a transient failure.** If the backend closed
  the socket because the device was deactivated or re-enrolled, reconnecting
  with the same token fails: the tablet needs a new `deviceSecret` (re-enroll)
  or an administrator has to re-enable the device.
