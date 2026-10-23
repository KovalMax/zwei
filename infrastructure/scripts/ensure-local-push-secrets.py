#!/usr/bin/env python3
"""Create ignored, random push crypto keys for the local Compose environment."""

from pathlib import Path
import secrets


env_file = Path(__file__).resolve().parents[1] / ".env"
lines = env_file.read_text(encoding="utf-8").splitlines() if env_file.exists() else []
values = {line.partition("=")[0]: line.partition("=")[2].strip() for line in lines if "=" in line}
current = values.get("PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION", "v1") or "v1"
needed = ["PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "PUSH_SUBSCRIPTION_FINGERPRINT_KEY"]
if current == "v2":
    needed.append("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2")
for key in needed:
    value = values.get(key, "")
    # Generate only absent/empty values. Never rotate a stable local secret as
    # a side effect of stack startup; malformed values are surfaced by service config.
    if not value:
        values[key] = secrets.token_hex(32)
for key in ("PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V1", "PUSH_SUBSCRIPTION_ENCRYPTION_KEY_V2", "PUSH_SUBSCRIPTION_FINGERPRINT_KEY", "PUSH_SUBSCRIPTION_ENCRYPTION_CURRENT_VERSION"):
    if key in values and not any(line.startswith(f"{key}=") for line in lines):
        lines.append(f"{key}={values[key]}")
for index, line in enumerate(lines):
    key = line.partition("=")[0]
    if key in values:
        lines[index] = f"{key}={values[key]}"

env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
env_file.chmod(0o600)
