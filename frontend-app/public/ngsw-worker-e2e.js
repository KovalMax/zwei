/*
 * E2E-only standalone service worker. ng serve does not emit Angular's
 * generated ngsw-worker.js, so this fixture implements only the worker-client
 * message protocol consumed by Angular's SwPush.notificationClicks.
 */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('message', event => {
  const command = event.data;
  if (!command || command.type !== 'ZWEI_E2E_NOTIFICATION_CLICK') return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const client of clients) {
      client.postMessage({
        type: 'NOTIFICATION_CLICK',
        data: {action: command.action ?? '', notification: {data: command.notificationData}},
      });
    }
    event.ports[0]?.postMessage({type: 'ZWEI_E2E_NOTIFICATION_CLICK_ACK', clients: clients.length});
  })());
});
