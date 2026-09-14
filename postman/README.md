# Postman — remote_control_backend

Local manual testing of the backend. The contract these files follow is
[../docs/ENDPOINTS.md](../docs/ENDPOINTS.md); if a request here ever disagrees
with that file, the file wins and the collection is the one to fix.

```text
remote_control_backend.postman_collection.json    Collection v2.1
remote_control_backend.postman_environment.json   Environment
```

No real credential is stored in either file.

---

## 1. Run the backend

```powershell
npm install
npm run start:dev
```

The server listens on `PORT` (default `3000`) and registers no global prefix.

## 2. Create the first administrator

`POST /auth/register` requires an `admin` token, so a brand new database has
nobody who can create users. The first administrator is created from the console,
never through an endpoint:

```powershell
$env:BOOTSTRAP_ADMIN_EMAIL = "admin@example.com"
$env:BOOTSTRAP_ADMIN_PASSWORD = "<password>"
$env:BOOTSTRAP_ADMIN_FULL_NAME = "Administrator"
npm run bootstrap:admin
```

On Linux/macOS, or in Git Bash:

```bash
BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
BOOTSTRAP_ADMIN_PASSWORD="<password>" \
BOOTSTRAP_ADMIN_FULL_NAME="Administrator" \
npm run bootstrap:admin
```

The variables can also be filled in the local `.env`, but the command line keeps
the password out of every file. Running the script a second time does not create
another administrator.

The password must satisfy the same rules as `POST /auth/register` (6–50
characters, with an uppercase letter, a lowercase letter and a digit or symbol):
otherwise the account would be created and could not log in, because
`POST /auth/login` validates the same pattern.

### Reset administrator password

If the administrator password is lost, it is also recovered from the console.
There is no forgot-password endpoint, no reset token and no way to do this from
`remote_control_web`:

```powershell
$env:RESET_ADMIN_EMAIL = "admin@example.com"
$env:RESET_ADMIN_PASSWORD = "<new-password>"
npm run reset:admin-password
```

On Linux/macOS, or in Git Bash:

```bash
RESET_ADMIN_EMAIL=admin@example.com \
RESET_ADMIN_PASSWORD="<new-password>" \
npm run reset:admin-password
```

The variables are deliberately **not** the `BOOTSTRAP_ADMIN_*` ones: those tend
to stay written in a deployment's `.env`, and sharing them would let a bare
`npm run reset:admin-password` silently put the old password back in place.

The script only changes the `password` column of an account that already exists
and already holds the `admin` role. It never creates the user, never grants the
role and never touches `email`, `fullName`, `roles` or `isActive`:

```text
email not registered        Administrator not found.                     exit 1
email is not an admin       User exists but is not an administrator.     exit 1
admin, but isActive false   password changed, warns that login still 401 exit 0
```

The new password must satisfy the same rules as `POST /auth/login`, which is
checked before connecting to the database — the value itself is never printed,
not even in the validation error. Afterwards, log in with it from
`01 - Authentication / Login user` to confirm.

## 3. Import the collection

Postman → *Import* → `remote_control_backend.postman_collection.json`.

## 4. Import the environment

Postman → *Import* → `remote_control_backend.postman_environment.json`, then
select it in the environment selector (top right). Nothing works without it: the
requests are built entirely out of its variables.

## 5. Configure `baseUrl`

Default:

```text
baseUrl = http://localhost:3000
```

For a VS Code Dev Tunnel, replace that single variable — no request has a
hardcoded host:

```text
baseUrl = https://w4qb7jsw-3000.brs.devtunnels.ms
```

(that URL is an example of a development tunnel, not a secret). The tunnel has to
be **public**, or Postman gets the tunnel's login page instead of the API. The
same value is what the Flutter clients use as their API base URL.

## 6. Configure the user credentials

Fill in the environment:

```text
userEmail      the email given to npm run bootstrap:admin
userPassword   its password
```

Both start empty on purpose. Do not commit them back into this repository.

## 7. Log in

Run `01 - Authentication / Login user`. Its test script stores `userToken`, which
every technician/admin request uses as `Authorization: Bearer {{userToken}}`.

The token lasts 2 hours. When it expires, run *Login user* again or
`Check user status`, which stores the renewed one.

## 8. Follow the folders in order

```text
01 - Authentication
02 - Devices
03 - Device enrollment and authentication
04 - Support requests - Device
05 - Support requests - Technician
06 - Remote sessions
```

---

## End-to-end flow

```text
01  Login user                              01 - Authentication
02  Create device                           02 - Devices
03  Generate enrollment                     02 - Devices
04  Activate device                         03 - Device enrollment ...
05  Device login                            03 - Device enrollment ...
06  Device check-status                     03 - Device enrollment ...
07  Create support request                  04 - Support requests - Device
08  List support requests (status=WAITING)  05 - Support requests - Technician
09  Assign support request                  05 - Support requests - Technician
10  Accept support request                  04 - Support requests - Device
11  Create remote session                   06 - Remote sessions
12  Get current remote session - Device     06 - Remote sessions
13  Close remote session                    06 - Remote sessions
```

### Step 09 needs the device to be ONLINE

`POST /support-requests/:id/assign` answers `409` when the device is offline, and
step 11 cannot happen without step 09. A device is ONLINE only while it holds an
open Socket.IO connection to the `/devices` namespace, and **no HTTP request can
create one**: Postman alone gets as far as step 08.

To go past it, the tablet app (or any Socket.IO client authenticated with the
`deviceToken` stored by *Device login*) has to be connected. See
[../docs/REALTIME.md](../docs/REALTIME.md).

---

## Variables

Captured automatically by the test scripts:

```text
userToken          Login user, Check user status
deviceId           Create device, Generate enrollment, Activate device
publicId           Create device, Generate enrollment, Activate device
enrollmentCode     Generate enrollment
deviceSecret       Activate device
deviceToken        Device login
supportRequestId   Create support request, Get current support request
remoteSessionId    Create remote session, Get current remote session - Device
```

Filled in by hand:

```text
baseUrl
userEmail
userPassword
```

Nothing is written to the console by any script.

`enrollmentCode` and `deviceSecret` are shown by the backend once and only once,
in the response that creates them. They end up in the Postman environment because
this is a local testing tool; treat that environment as it deserves and never
export it with values in it.

---

## Realtime

The Socket.IO namespaces

```text
/devices
/technicians
```

are documented in [../docs/REALTIME.md](../docs/REALTIME.md). They are not
representable as HTTP requests, so this collection contains no fake REST calls
for presence, signaling or WebRTC.

---

## Keeping this in sync

A backend change that alters a route, a method, a request body, a response, the
authentication or the roles of an endpoint represented here must update this
collection in the same change, together with `docs/ENDPOINTS.md`.
