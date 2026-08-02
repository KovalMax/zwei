# Frontend

Angular 22 client for Zwei. Use the repository Docker Compose commands rather than host-installed Node tooling.

```sh
make build
make start
make e2e
```

The frontend is served through `https://chat.localhost`; the internal development server is available on port `4200`. Browser end-to-end testing uses Dockerized Playwright from `e2e/`.
