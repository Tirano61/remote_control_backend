# remote_control_backend

## Project overview

`remote_control_backend` is the backend for a remote support and remote control system for Android devices.

The goal is to build a system conceptually similar to TeamViewer, focused initially on Android tablets and devices used by our customers.

Remote access is **assisted**, not unattended by default.

A typical flow will be:

1. An Android device has the Remote Control client installed.
2. Each device has a persistent identity in the backend.
3. The device user requests technical assistance.
4. An authenticated technician sees the support request from the technician application.
5. The technician accepts/takes the request.
6. The device user explicitly authorizes the remote session.
7. A temporary remote-control session is established.
8. The technician can view and control the Android device.
9. Either side can end the session.
10. The session is closed and recorded.

The system must be designed so that remote access exists only for an authorized session.

---

## Main system components

The complete system is expected to have three main application components.

### Backend

This repository:

```text
remote_control_backend
```

Technology:

```text
NestJS
TypeScript
TypeORM
PostgreSQL
JWT
Passport
WebSocket / Socket.IO when required
```

### Android client

Will be developed separately using Flutter.

Flutter will handle the application architecture and UI.

Android-specific functionality may use Kotlin/native Android code through Flutter platform integration when necessary.

Expected future Android-specific features include:

```text
MediaProjection
AccessibilityService
ForegroundService
WebRTC
Android device information
possibly DevicePolicyManager / kiosk mode
```

Do not implement Android functionality in this backend repository.

### Technician application

Will also be developed separately using Flutter, initially targeting Flutter Web.

It will provide:

```text
technician login
device management
support request management
remote session screen
remote video
mouse/touch control
keyboard/control commands
session termination
```

---

# Remote-control architecture

The backend is responsible for control-plane functionality.

It should manage:

```text
users / technicians
devices
device authentication
support requests
remote sessions
authorization
session state
WebRTC signaling
audit/history
```

The backend should NOT normally relay the remote screen video.

The intended architecture is:

```text
Android Device
      │
      │ HTTPS / WebSocket
      ▼
remote_control_backend
      ▲
      │ HTTPS / WebSocket
      │
Technician Flutter Web
```

The backend will later exchange WebRTC signaling information between both clients.

Once WebRTC is established, the intended communication is:

```text
Android Device  <==========>  Technician
                     WebRTC
```

The remote screen video and remote-control commands should travel directly through WebRTC whenever possible.

TURN may be used when a direct connection cannot be established.

STUN/TURN infrastructure is NOT part of the NestJS application itself.

A self-hosted `coturn` server may be used later.

Do not implement STUN, TURN or a media relay inside NestJS.

---

# Current repository state

The project currently contains only the authentication/user functionality required as the starting point.

Current technologies:

```text
NestJS 11
TypeORM
PostgreSQL
Passport
JWT
class-validator
```

The existing authentication implementation must be reused rather than replaced.

---

# Authentication

Authentication is implemented in the existing `auth` module.

The project currently uses:

```text
JWT
Passport
```

User login already exists.

Inactive users must not be able to log in.

The login response includes relevant user information such as:

```text
roles
isActive
```

There is also:

```text
GET /auth/check-status
```

This endpoint:

* requires authentication;
* validates the current user/session;
* returns the authenticated user;
* returns a renewed token.

It is intended to be used by the Flutter client when restoring an authenticated session.

Do not create a second authentication implementation.

Do not replace the existing JWT/Passport architecture unless explicitly requested.

## Administrative bootstrap and password recovery

Administrative bootstrap/password recovery is CLI-only.

Never expose it as HTTP endpoints.

```text
npm run bootstrap:admin        creates the first administrator
npm run reset:admin-password   changes the password of an existing administrator
```

Neither creates an HTTP route, and neither promotes, demotes or activates an
account.

---

# Authorization and roles

There must be only one mechanism for protecting routes by roles.

Use:

```typescript
@Auth()
```

or:

```typescript
@Auth(...roles)
```

depending on the required authorization.

Do NOT introduce alternative route protection mechanisms such as:

```text
manual AuthGuard() usage on controllers
@SetMetadata directly for roles
manual role guards on individual routes
another custom role decorator
```

The existing `@Auth()` decorator is the project's source of truth for endpoint authentication and role authorization.

The existing enum:

```text
ValidRoles
```

is the source of truth for user roles.

Do not duplicate roles as arbitrary strings.

Before adding a new role, inspect the existing roles and determine whether one already represents the required permission.

Do not add roles unless the requested functionality actually requires them.

---

# Device authentication is separate from technician authentication

This distinction is fundamental.

There will eventually be two different identities connecting to the backend:

```text
Technician/User
Device
```

Technicians authenticate using the existing user/JWT authentication.

Android devices must NOT authenticate by pretending to be users and must NOT store technician credentials.

Devices will later receive their own secure identity and authentication mechanism.

Conceptually:

```text
Technician
email/password
    ↓
User JWT
```

and separately:

```text
Android Device
device identity / secure credential
    ↓
Device authentication
```

Do not implement device authentication until explicitly requested by a development prompt.

Do not reuse technician JWT credentials as permanent device credentials.

---

# Expected domain modules

The backend will evolve incrementally.

Expected modules include:

```text
auth                 existing
devices
support-requests
remote-sessions
signaling
audit
```

Potential future modules may include:

```text
organizations / customers
device groups
technician permissions
```

Do not create future modules before they are requested.

Development should proceed in small, reviewable steps.

---

# Devices

Each Android installation will eventually be represented by a persistent backend device.

A device will have two concepts of identity.

### Internal ID

Use a UUID for internal database relationships.

Example:

```text
550e8400-e29b-41d4-a716-446655440000
```

### Public ID

Devices should also have a human-friendly identifier suitable for a customer to communicate to a technician.

Example:

```text
384-729-142
```

The public ID is NOT intended to be sufficient authentication by itself.

It is an identifier, not a password.

Device authentication will be implemented separately.

---

# Support requests

The intended assisted-support flow is:

```text
Device user
    ↓
Request assistance
    ↓
SupportRequest WAITING
    ↓
Technician takes request
    ↓
ASSIGNED
    ↓
Device user accepts
    ↓
RemoteSession
```

The user on the Android device should explicitly authorize the remote-control session.

Do not implement support requests until explicitly requested.

---

# Remote sessions

A remote session represents one temporary authorization between:

```text
one technician
one device
```

It should eventually allow us to know:

```text
who connected
which device was controlled
when the session started
when it ended
how long it lasted
how it ended
```

Remote access must be tied to a valid session.

A technician being authenticated in the backend does NOT automatically grant permanent control over every device.

---

# WebRTC and signaling

WebRTC will be used later for the actual remote connection.

Expected WebRTC traffic includes:

```text
video track
data channel
```

The Android device will send the remote screen as video.

The technician client will send remote-control commands using a WebRTC DataChannel.

Examples of future control commands:

```text
tap
longPress
swipe
drag
scroll
back
home
recentApps
text input
```

NestJS will NOT execute Android gestures.

The backend will only participate in:

```text
authentication
authorization
session coordination
signaling
```

Expected signaling messages may include:

```text
offer
answer
ICE candidate
session close
```

Do not implement WebRTC signaling until explicitly requested.

---

# WebSockets

Persistent/realtime communication will eventually be required for:

```text
device presence
support requests
technician assignment
session lifecycle
WebRTC signaling
```

Do not introduce Socket.IO/WebSocket infrastructure prematurely.

When WebSockets are implemented, authentication and authorization must still be enforced.

Never trust a client-supplied:

```text
userId
technicianId
deviceId
sessionId
```

without validating that the authenticated connection is authorized to use it.

---

# Online/offline state

Device administrative state and realtime connection state are different concepts.

For example:

```text
isActive
```

means the device is administratively enabled.

It must NOT be confused with:

```text
ONLINE
OFFLINE
```

which represents connection/presence.

Keep those concepts separated.

---

# Security principles

Security is particularly important because this project will eventually allow remote control of physical Android devices.

Follow these principles.

### Never trust client identity fields

Do not authorize a request simply because the body contains:

```text
technicianId
deviceId
userId
```

Use authenticated identity and backend relationships.

### Public device IDs are not secrets

Something such as:

```text
384-729-142
```

may be visible to users.

Never treat it as sufficient proof of device ownership or authorization.

### Session-scoped remote access

Remote-control authorization should eventually be limited to a specific:

```text
RemoteSession
```

Do not design permanent universal remote-control tokens.

### Secrets

Never:

```text
commit credentials
hardcode JWT secrets
hardcode database credentials
return credential hashes through APIs
log sensitive tokens
```

Environment secrets belong in environment variables.

### Passwords

Follow the existing password hashing implementation.

Never store plaintext passwords.

---

# TypeORM conventions

Use TypeORM decorators appropriately.

For identifiers:

```typescript
@PrimaryGeneratedColumn('uuid')
```

when UUIDs are required.

For timestamps prefer:

```typescript
@CreateDateColumn()
@UpdateDateColumn()
```

instead of manually maintaining timestamp values.

Database constraints must enforce important invariants.

For values that must be unique, use a database-level unique constraint rather than relying only on an application-level check.

---

# DTOs and validation

Do not accept TypeORM entities directly as controller request bodies.

Use DTOs.

Use `class-validator` consistently with the existing application.

DTOs should expose only fields that the client is allowed to modify.

For example, clients generally must not be allowed to directly set:

```text
id
createdAt
updatedAt
```

or other server-controlled fields.

---

# Error handling

Prefer standard NestJS exceptions such as:

```text
BadRequestException
UnauthorizedException
ForbiddenException
NotFoundException
ConflictException
```

Do not invent custom response formats unnecessarily when NestJS already provides appropriate HTTP semantics.

---

# Code organization

Follow NestJS module boundaries.

Typical structure:

```text
src/
  auth/
  devices/
    dto/
    entities/
    devices.controller.ts
    devices.service.ts
    devices.module.ts
```

Do not over-engineer the structure.

Create additional abstractions only when they solve an actual problem.

---

# Imports

Prefer import styles compatible with both development and compiled production execution.

Do not introduce imports that work under `nest start` but fail with:

```text
node dist/main
```

Follow the import convention already established in the repository.

---

# Scope discipline

Development prompts for this project intentionally use small steps.

Implement only the functionality explicitly requested by the current prompt.

Do not proactively implement the next stages of the roadmap.

For example, if the task is to create `DevicesModule`, do not also introduce:

```text
WebSockets
WebRTC
SupportRequest
RemoteSession
coturn
FCM
MediaProjection
```

unless specifically requested.

Small, reviewable changes are preferred over large speculative implementations.

---

# Existing code

Before changing an existing implementation:

1. Inspect the relevant files.
2. Understand the existing conventions.
3. Reuse existing utilities and architecture when appropriate.
4. Avoid duplicating mechanisms that already exist.

Do not rewrite working authentication or authorization code merely to match a preferred architecture.

The current repository state is authoritative.

---

# Client contract documentation

The backend contract consumed by the Flutter clients is documented in:

```text
docs/ENDPOINTS.md
docs/REALTIME.md
```

Both files begin with the same statement:

```text
These files document the current public contract of remote_control_backend.

If implementation and documentation ever disagree, the implementation must be
reviewed and the documentation updated in the same backend change.
```

## Flutter clients

These two applications consume those files as their contract:

```text
remote_control_device
remote_control_web
```

They are developed in separate repositories and cannot read this backend's code.
The documentation is what they build against.

Therefore:

* do not write ambiguous documentation;
* do not document future behaviour as if it already existed;
* document what the code actually does, not what the roadmap intends;
* prefer stable HTTP status codes and error codes over exact exception strings,
  so a client never has to match on a human-readable message.

## REST contract rule

Any future prompt that:

* adds an endpoint;
* removes an endpoint;
* changes a route;
* changes an HTTP method;
* changes a request DTO;
* changes a response;
* changes authentication;
* changes roles;
* changes relevant functional errors;

must review and update:

```text
docs/ENDPOINTS.md
```

in the same change.

## Realtime contract rule

Any future prompt that:

* adds or removes a namespace;
* adds or removes an event;
* changes a payload;
* changes an ACK;
* changes an error code;
* changes Socket.IO authentication;
* changes join rules;
* changes signaling;

must review and update:

```text
docs/REALTIME.md
```

in the same change.

## Postman collection rule

The manual test collection lives in:

```text
postman/remote_control_backend.postman_collection.json
```

When a change modifies the REST contract, updating `docs/ENDPOINTS.md` is not
enough: if the modified endpoint is represented in the collection, the collection
must be updated in the same change.

That includes:

* a route or HTTP method that changes;
* a request body that changes;
* a response field the collection captures into an environment variable;
* the authentication or the roles of an endpoint;
* the HTTP status a request asserts.

Do not let the Postman collection go stale.

Purely internal changes that do not alter requests or responses do not require
touching it.

## No deferred documentation

Documentation updates are part of the change that causes them.

Do not leave them for a later prompt.

---

# Verification

After development changes:

```text
run lint
run build / compile
```

Fix errors introduced by the changes.

Do not claim a command succeeded unless it was actually executed successfully.

If an existing unrelated problem prevents verification, report it clearly rather than modifying unrelated parts of the project.

If the change touched any public REST route or realtime event, also verify that `docs/ENDPOINTS.md` and `docs/REALTIME.md` still match the code, and that `postman/remote_control_backend.postman_collection.json` still matches any endpoint it represents.

---

# Out-of-scope cleanup

Do not perform unrelated repository cleanup unless explicitly requested.

Known unrelated issues may exist.

Examples include:

```text
old README content
old scripts
stale tests
environment template cleanup
```

Do not modify them merely because they were noticed while implementing another feature.

They can be handled by dedicated prompts.

---

# Development prompt convention

This project uses numbered prompts so development progress can be followed reliably.

The project name is:

```text
remote_control_backend
```

Every development prompt must explicitly contain:

```text
Proyecto: remote_control_backend
Prompt: <incremental number>
```

The prompt title must be placed on the following line.

Example:

```text
Proyecto: remote_control_backend
Prompt: 1

# remote_control_backend — Prompt 1 — BACKEND — Crear módulo Devices
```

Prompt numbers are incremental and belong specifically to this project.

Do not reuse numbering from unrelated projects.

---

# Current development direction

The immediate planned progression is approximately:

```text
1. Devices and persistent device identity
2. Secure device registration/authentication
3. Device presence
4. Support requests
5. Remote sessions
6. Signaling
7. WebRTC integration
8. Remote screen/control
```

This is a roadmap, not authorization to implement all of these features.

Only implement the current requested step.

---

# General rule

When there is a conflict between:

1. assumptions from this document;
2. the actual current repository;
3. explicit instructions in the current development prompt;

follow this priority:

```text
current explicit prompt
        ↓
current repository state
        ↓
CLAUDE.md background context
```

The current prompt is always authoritative for the task being performed.
