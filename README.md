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

Run browser tests with `make e2e` and stop the stack with `make stop`.
