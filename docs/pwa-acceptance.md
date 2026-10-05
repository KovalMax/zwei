# PWA browser acceptance matrix

| Browser state | Acceptance criterion |
| --- | --- |
| Production app online on an HTTP `localhost` origin | The real Angular production service worker controls the page and Cache Storage contains `index.html` plus JavaScript/CSS shell assets. |
| Private API probe online | `/api/private-probe` returns its private sentinel from the network, while neither its URL nor sentinel body appears in Cache Storage. |
| `/login` while online, then context goes offline | `offline` updates the root PWA state and writes only a transient `zwei.pwa.offline=true` session marker, not private data. The accessible status is visible before navigation. |
| `/login` navigation after browser context goes offline | A real reload gets a new document controlled by the service worker and renders the login heading from the cached app shell. Chromium reports `navigator.onLine === true` and may emit repeated startup `online` signals for this service-worker-served offline navigation, so the facade preserves the restored transient marker through all startup online events. Only an HTTP response other than a service-worker-generated 504 or a network failure confirms connectivity and clears it. The private API probe remains unavailable and private data stays absent from Cache Storage. |
| Offline shell dark and light themes at 1280×720 | Capture both theme states; assert the status is rendered with a non-zero computed rectangle inside the viewport, and check the login app shell and route remain visible. |

Cross-platform installation (OS prompts, desktop/mobile install affordances, and installed-app behavior) remains browser/OS-specific and is deferred for separate manual verification on supported platforms. The README describes the installation flow as available where supported; it does not claim Safari, macOS, or other OS behavior has been tested.
