# Zwei

<p align="center">
  <img src="assets/zwei-logo.svg" alt="Zwei logo" width="112">
</p>

<h2 align="center">Private conversations, deliberately simple.</h2>

Zwei is a private, server-mediated messaging app for direct and small-group conversations. It is designed for focused conversations rather than a public social feed.

## Conversations

- **Direct and group messaging:** chat one-to-one or in groups of up to 16 active members. Group member lists show display names and roles, not email addresses.
- **Stay in sync:** live messages, presence and typing indicators, delivery recovery, and conversation read state help people follow a conversation across devices.
- **Audio and screen sharing:** direct audio calls and group calls of up to four participants use WebRTC; screen sharing is available during calls.
- **Notifications and media:** browser push notifications and optional GIPHY search help people stay connected. Availability depends on browser support and configuration.
- **A considerate interface:** responsive layouts, light and dark themes, keyboard-visible focus, and reduced-motion support.

Zwei protects application data and browser sessions, but messages are **server-mediated, not end-to-end encrypted**. Audio and screen sharing use browser-to-browser WebRTC with TURN relay when needed. Optional GIPHY searches contact GIPHY directly and share search terms and client network metadata with that provider.

## Install in your browser

Zwei is a progressive web app, not a signed native application. Where supported, install it from your browser over HTTPS. Installation behavior varies by browser and operating system. If the app is stale after an update, use **Update available — Reload** in the account menu.

## How it is built

The Angular and TypeScript client communicates with Go authentication, chat, and realtime services. PostgreSQL stores durable data, Redis coordinates realtime activity, and WebRTC carries call media. Playwright exercises browser flows.

## Get started locally

Local development uses Docker Compose and `make`; see the [development and operations guide](docs/operations.md) for prerequisites, testing, and deployment details.

```sh
make build
make migrate
make trust-local-ca   # macOS, once
```

Open `https://chat.localhost` after trusting the local certificate. Use `make start` for subsequent starts and `make help` for available commands.

## Contributing

Contributions are welcome. Keep changes focused, add tests for the affected behavior, and run the relevant Docker-backed checks. Do not commit secrets, local configuration, or generated test artifacts. For larger product or compatibility decisions, open an issue first.
