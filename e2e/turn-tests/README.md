# Isolated TURN credential-renewal acceptance

Run `make e2e-turn` from the repository root. This is separate from the normal
Playwright suites. It uses the parallel harness lock, subnet-overlap checks,
private Compose network and disposable database/Redis, and publishes no ports.
It builds a uniquely tagged realtime image with `e2e_turn`: only this test
binary uses 45-second TURN credentials. Ordinary and production builds retain
the two-hour maximum. Never deploy the test image or use the build tag in a
release build.

The harness generates a disposable TURN secret, pins the TURN URLs directly to
the private coturn IP (rather than a `.localhost` hostname), and discards coturn
logs. This transport-specific URL is test-only; production continues to use its
configured TURN hostname. The test uses real Chromium
peer connections with relay-only ICE, fake microphone capture, and real time.
Coturn disables anonymous STUN and enables the approved provisional cap of 100
UDP 401 responses per source per second. Its pinned image keeps the CLI off by
default; do not pass `--cli` or the removed `--no-cli` option. A separate
raw-UDP check requires no
anonymous Binding response and verifies an unauthenticated Allocate burst is
bounded; it permits two fixed one-second windows for a sub-second burst. The
wrong-password browser probe separately requires a 401 on the selected
transport and no relay candidate. Chromium may leave ICE gathering pending after
that authentication error, so the probe is bounded but does not treat gathering
completion as the authentication contract.
On both participants it requires the selected pair to be relay-to-relay and
growing audio RTP before expiry. It correlates the credential response with its
request, checks that the same peer installs those credentials, snapshots its
selected pair synchronously before installation, then requires a restart and
new local relay pair. After the original expiry it checks continued RTP and
fresh allocations: the old credential must fail and the refreshed one must
succeed. Sanitized packet/byte, track-state and connection-state counters aid
diagnosis without exporting identifiers or payloads.

The suite exercises UDP TURN for credential renewal across expiry, simultaneous
restart-offer rollback, and lost-offer retry. A separate authenticated TCP
scenario restricts the browser-to-TURN-server connection to TCP while retaining
UDP media relay (`--no-tcp-relay` remains enabled); it requires a relay pair and
bidirectional RTP before ending the call. The coordinated-restart scenario
holds each browser's outgoing signaling until both native peers have outstanding
local offers, then releases both streams and requires a real rollback collision.
Buffered frames remain in the owning browser, are capped, and are discarded on
the six-second barrier deadline or browser teardown. This test-only coordination
does not alter the application or replace either native peer connection.

The dedicated Playwright config retains passing screenshots under
`e2e/test-results/<run-id>/` for visual review. Traces and video stay disabled
because they can retain signaling details. The test does not export SDP,
candidate data, or credentials. A process-group watchdog covers builds, setup
and the browser run (300 seconds, followed by five seconds before SIGKILL);
Docker cleanup operations have their own bounded deadlines. The harness removes
its own project, volumes, and images on exit. This does not replace the ordinary
full browser suite.
