# Zwei

Private, server-mediated one-to-one messaging. Users can register, sign in, find other users, create conversations, and exchange messages in real time.

## Stack

- Angular 22 frontend
- Go services for authentication, chat, real-time messaging, and background work
- PostgreSQL for persistent data
- Redis for future ephemeral coordination and fan-out
- Traefik with local TLS
- Docker Compose for local development

## Run Locally

Requirements: Docker Desktop and `make`.

```sh
make build
make migrate
make trust-local-ca   # macOS, once
```

Open `https://chat.localhost` and restart the browser after trusting the local CA. The local environment and Docker Compose override files are created automatically from their `.dist` files.

The application uses these local hosts:

- `chat.localhost` - frontend
- `kyc.localhost` - administrator frontend (IP-allowlisted by the auth service)
- `auth.localhost` - authentication API
- `api.chat.localhost` - chat API
- `ws.chat.localhost` - WebSocket messaging
- `turn.chat.localhost` - TURN/STUN endpoint on UDP and TCP port 3478; relayed UDP uses ports 49160-49200 and is published directly by coturn, not Traefik

Run browser tests with `make e2e` and stop the stack with `make stop`. Local Mailpit is available at
`http://localhost:8025`. Ordinary registrations do not send an email immediately: the activation
email is sent after an administrator approves the account. Creating an invitation sends the
recipient a single-use account-creation link containing the invitation query parameters; the code
also remains visible to the administrator as a fallback. E2E runs reset and migrate
the isolated PostgreSQL `messenger_test` database, point auth/chat/realtime at it for the duration
of the run, and restore the development database connections afterward. The `messenger` development
database is not used or modified by browser tests.

## KYC administration

The production administrator frontend is `https://kyc.chat.false.tel`. It uses the same Angular
build and visual system as the chat application. The auth service protects the administrator API
and KYC-host authentication with `ADMIN_ALLOWED_IPS`; configure this as a comma-separated list of
IP addresses or CIDR ranges in the VM environment. The service trusts the client address forwarded
by the private Traefik edge, so the auth container must not be published directly.

Traefik also applies Basic Auth to the KYC frontend shell. The API routes remain protected by the
application admin account and IP allowlist because Angular must use its bearer token there. In
production, keep the bcrypt htpasswd file outside the synchronized release directory and point
`KYC_BASIC_AUTH_FILE` at its absolute path.

For example, create it interactively on the VM:

```sh
install -d -m 700 /home/usermax/zwei-secrets
htpasswd -cB /home/usermax/zwei-secrets/kyc.htpasswd kyc-admin
chmod 600 /home/usermax/zwei-secrets/kyc.htpasswd
```

Create an administrator manually from the auth container:

```sh
docker compose exec auth /usr/bin/service admin create
```

The command prompts for the administrator email, display name, and password. Normal registrations
remain pending until an administrator activates them. Activation sends an email through the SMTP
settings and the recipient must use the single-use link before signing in. Invitation links use the
form `?invite=1&code=...` and create active, verified accounts immediately.

## Production TURN

`infrastructure/production/docker-compose.yml` publishes coturn directly at
`turn.chat.false.tel`; Traefik does not route TURN traffic. Set `TURN_SHARED_SECRET` to a
high-entropy value and `TURN_EXTERNAL_IP` to the VM public IPv4 address in the production `.env`.
Allow inbound TCP and UDP 3478 and UDP 49160-49200 in the VM firewall and DNS-resolve
`turn.chat.false.tel` to that public IP. Do not add a wildcard or Traefik router for the TURN host.
