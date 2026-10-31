# Isolated TURN credential-renewal acceptance

Run `make e2e-turn` from the repository root. This is separate from the normal
Playwright suites. It uses the parallel harness lock, subnet-overlap checks,
private Compose network and disposable database/Redis, and publishes no ports.
It builds a uniquely tagged realtime image with `e2e_turn`: only this test
binary uses 45-second TURN credentials. Ordinary and production builds retain
the two-hour maximum. Never deploy the test image or use the build tag in a
release build.

The harness generates a disposable TURN secret, pins the TURN URL to the
private coturn service, and discards coturn logs. The test uses real Chromium
peer connections with relay-only ICE, fake microphone capture, and real time.
On both participants it requires the selected pair to be relay-to-relay and
growing audio RTP before expiry. It correlates the credential response with its
request, checks that the same peer installs those credentials, snapshots its
selected pair synchronously before installation, then requires a restart and
new local relay pair. After the original expiry it checks continued RTP and
fresh allocations: the old credential must fail and the refreshed one must
succeed. Sanitized packet/byte, track-state and connection-state counters aid
diagnosis without exporting identifiers or payloads.

A second scenario holds each browser's outgoing restart signaling until both
native peers have outstanding local offers, then releases both streams and
requires a real rollback collision. Buffered frames remain in the owning
browser, are capped, and are discarded on the six-second barrier deadline or
browser teardown. This test-only coordination does not alter the application
or replace either native peer connection. Both scenarios retain the same
post-expiry relay, fresh-allocation and bidirectional RTP assertions.

The dedicated Playwright config disables traces, screenshots, and video; output
files live only in the disposable runner container. The test does not export
SDP, candidate data, or credentials. A process-group watchdog covers builds,
setup and the browser run (300 seconds, followed by five seconds before SIGKILL);
Docker cleanup operations have their own bounded deadlines. The harness removes its own
project, volumes, and images on exit. This does not replace the ordinary full
browser suite.
