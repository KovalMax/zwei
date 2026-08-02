# P2P Web Chat

Private server-mediated one-to-one chat. “P2P” describes the conversation model, not browser-to-browser transport.

## Stack

- Angular 22 frontend
- Go auth, chat, realtime, and worker services
- PostgreSQL for durable state
- Redis reserved for ephemeral coordination and future realtime fan-out
- Traefik with local TLS for development routing

## Local Development

Docker Compose is the supported workflow. Copying the local environment and override files is handled automatically by `make start` and `make build`.

```sh
make build
make start
make migrate
make e2e
```

Open `https://chat.localhost`. Run `make trust-local-ca` once on macOS, then fully restart the browser. See `make help` for all commands and `docs/REVIVAL_PLAN.md` for architecture, scope, and remaining work.
