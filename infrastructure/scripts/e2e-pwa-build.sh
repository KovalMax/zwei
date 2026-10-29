#!/usr/bin/env bash
# Build a second production app with a distinct Angular service-worker version.
# The generated configuration and output are confined to the ignored dist tree.
set -Eeuo pipefail
"$@" exec -T frontend node -e '
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync("ngsw-config.json", "utf8"));
config.appData = {e2eVersion: "second-production-build"};
fs.mkdirSync("dist", {recursive: true});
fs.writeFileSync("dist/ngsw-e2e-config.json", JSON.stringify(config));
'
"$@" exec -T frontend npm run build -- --configuration production --output-path dist/pwa-update --service-worker dist/ngsw-e2e-config.json
