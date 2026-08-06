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
- `auth.localhost` - authentication API
- `api.chat.localhost` - chat API
- `ws.chat.localhost` - WebSocket messaging
- `turn.chat.localhost` - TURN/STUN endpoint on UDP and TCP port 3478; relayed UDP uses ports 49160-49200 and is published directly by coturn, not Traefik

Run browser tests with `make e2e` and stop the stack with `make stop`.

## Production TURN

`infrastructure/production/docker-compose.yml` publishes coturn directly at
`turn.chat.false.tel`; Traefik does not route TURN traffic. Set `TURN_SHARED_SECRET` to a
high-entropy value and `TURN_EXTERNAL_IP` to the VM public IPv4 address in the production `.env`.
Allow inbound TCP and UDP 3478 and UDP 49160-49200 in the VM firewall and DNS-resolve
`turn.chat.false.tel` to that public IP. Do not add a wildcard or Traefik router for the TURN host.
