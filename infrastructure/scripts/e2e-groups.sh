#!/usr/bin/env bash

# Keep validation and execution sourced from one file-to-group assignment.
E2E_CHAT_SPECS=(tests/chat-flow.spec.ts)
E2E_OTHER_SPECS=(
  tests/archive-chat.spec.ts
  tests/auth-flow.spec.ts
  tests/giphy-live.spec.ts
  tests/group-list-pagination.spec.ts
  tests/kyc-flow.spec.ts
  tests/pwa-offline.spec.ts
  tests/visual-baseline.spec.ts
)
