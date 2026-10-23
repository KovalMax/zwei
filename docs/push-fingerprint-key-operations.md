# Push fingerprint-key operations

The push endpoint fingerprint key is durable identity state shared by Auth and
Realtime. Both services atomically claim the identity on first startup and
refuse startup if their configured key differs. Automatic rotation is not
supported. Do not delete or edit the guard row as routine troubleshooting.

## Deliberate re-key

Re-keying invalidates every enrolled push subscription; users must explicitly
re-enroll. Accounts, sessions, and messages are preserved. Schedule a
maintenance window and stop **all** Auth and Realtime replicas before running
the operation. Leave PostgreSQL available. Run the one-shot Auth command with
the new key configured in the Auth environment; the command does not print the
key or its identity:

```sh
docker compose -p messenger \
  -f infrastructure/docker-compose.yml \
  -f infrastructure/docker-compose.override.yml \
  run --rm --no-deps auth /usr/bin/service admin rekey-push-fingerprint-key \
  --confirm-replicas-stopped
```

The command transactionally deletes `push_subscriptions` and replaces the
singleton `push_fingerprint_key_identity` value with the identity derived from
the configured fingerprint key. If it fails, the transaction leaves both
unchanged. Start Auth and Realtime only after the command succeeds, with the
same new key configured in both. The command's confirmation flag is an
operator attestation; it cannot detect replicas running elsewhere.
