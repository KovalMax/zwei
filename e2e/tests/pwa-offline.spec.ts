import {createServer, type Server} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {extname, join, normalize, relative, sep} from 'node:path';
import {expect, test} from '@playwright/test';

const productionRoot = '/production-app';
const privateSentinel = 'PRIVATE_E2E_SENTINEL';
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

async function startProductionServer(): Promise<{server: Server; origin: string; deployUpdate: () => void}> {
  let activeRoot = productionRoot;
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (requestPath === '/api/private-probe') {
      response.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      response.end(JSON.stringify({displayName: privateSentinel}));
      return;
    }

    const decodedPath = decodeURIComponent(requestPath);
    const normalizedPath = normalize(decodedPath).replace(/^([/\\])+/, '');
    const filePath = join(activeRoot, normalizedPath || 'index.html');
    const pathFromRoot = relative(activeRoot, filePath);
    if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '..') {
      response.writeHead(400).end();
      return;
    }

    try {
      const fileInfo = await stat(filePath);
      const resolvedFile = fileInfo.isDirectory() ? join(filePath, 'index.html') : filePath;
      const body = await readFile(resolvedFile);
      response.writeHead(200, {'content-type': contentTypes[extname(resolvedFile)] ?? 'application/octet-stream'});
      response.end(body);
    } catch {
      // Angular navigation requests use the real production index as the SPA shell.
      if (!extname(requestPath) && request.headers.accept?.includes('text/html')) {
        try {
          response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
          response.end(await readFile(join(activeRoot, 'index.html')));
          return;
        } catch {
          // Return a normal 404 below if the production build is missing.
        }
      }
      response.writeHead(404).end('Not found');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Production static server did not bind a TCP port');
  return {server, origin: `http://localhost:${address.port}`, deployUpdate: () => activeRoot = '/production-app-update'};
}

test('real Angular worker detects and activates a second production version', async ({page}) => {
  test.setTimeout(60_000);
  const {server, origin, deployUpdate} = await startProductionServer();
  try {
    const firstManifest = JSON.parse(await readFile(join(productionRoot, 'ngsw.json'), 'utf8')) as {appData?: unknown};
    const secondManifest = JSON.parse(await readFile('/production-app-update/ngsw.json', 'utf8')) as {appData?: {e2eVersion?: string}};
    expect(firstManifest.appData).not.toEqual(secondManifest.appData);
    expect(secondManifest.appData?.e2eVersion).toBe('second-production-build');
    await page.goto(`${origin}/login`);
    await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain('/ngsw-worker.js');
    await page.evaluate(() => {
      const state = window as typeof window & {workerEvents: unknown[]};
      state.workerEvents = [];
      navigator.serviceWorker.addEventListener('message', event => state.workerEvents.push(event.data));
    });
    deployUpdate();
    await page.evaluate(() => navigator.serviceWorker.controller?.postMessage({action: 'CHECK_FOR_UPDATES', nonce: 10001}));
    await expect.poll(() => page.evaluate(() => {
      const events = (window as typeof window & {workerEvents: Array<{type?: string; latestVersion?: {appData?: {e2eVersion?: string}}}>}).workerEvents;
      return events.some(event => event.type === 'VERSION_READY' && event.latestVersion?.appData?.e2eVersion === 'second-production-build');
    }), {timeout: 30_000}).toBe(true);
    // Detection must not itself navigate the document; activation is explicit.
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.evaluate(() => navigator.serviceWorker.controller?.postMessage({action: 'ACTIVATE_UPDATE', nonce: 10002}));
    await expect.poll(() => page.evaluate(() => {
      const events = (window as typeof window & {workerEvents: Array<{type?: string; nonce?: number; result?: boolean}>}).workerEvents;
      return events.some(event => event.type === 'OPERATION_COMPLETED' && event.nonce === 10002 && event.result === true);
    })).toBe(true);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
    await expect.poll(() => page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

// Acceptance matrix: pending root restore, both themes at 2560/1440/1024/390;
// refresh success and 401 complete to home and login respectively. The root
// has no selected/empty conversation state until navigation has completed.
for (const outcome of ['success', 'unauthorized'] as const) {
  test(`production root loading is centered during delayed ${outcome} restore`, async ({page, context}, testInfo) => {
    test.setTimeout(60_000);
    const {server, origin} = await startProductionServer();
    let release!: () => void;
    const pending = new Promise<void>(resolve => release = resolve);
    let refreshes = 0;
    const binding = {subject: crypto.randomUUID(), browser_id: crypto.randomUUID(), generation: crypto.randomUUID()};
    const pageErrors: string[] = [];
    const homeRequests = new Set<string>();
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
      await page.goto(`${origin}/pending`);
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.reload();
      await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await page.evaluate(value => localStorage.setItem('zwei.intended-session', JSON.stringify(value)), binding);
      if (outcome === 'unauthorized') await page.evaluate(() => sessionStorage.setItem('zwei.pwa.offline', 'true'));
      // Do not contact production services from the fixture.
      // Context routes also intercept the service worker's own fetches.
      await context.route('https://*.chat.false.tel/**', route => route.abort());
      const cors = {'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type'};
      await context.route(/https:\/\/(?:auth|api)\.chat\.false\.tel\/api\/(?:auth\/(?:me|media-policy|ws-ticket)|chat\/(?:conversations|groups))(?:\?.*)?$/, async route => {
        if (route.request().method() === 'OPTIONS') { await route.fulfill({status: 204, headers: cors}); return; }
        const path = new URL(route.request().url()).pathname;
        homeRequests.add(path);
        const body = path === '/api/auth/me' ? {id: binding.subject, email: 'fixture@example.test', display_name: 'Fixture User', retention_period: 'forever', auto_load_approved_media: false, alert_mode: 'off'} :
          path === '/api/auth/media-policy' ? {giphy_enabled: false} :
          path === '/api/auth/ws-ticket' ? {ticket: 'fixture-ticket'} :
          path === '/api/chat/groups' ? {items: [], next_cursor: null} : [];
        await route.fulfill({status: 200, headers: cors, json: body});
      });
      await context.routeWebSocket('wss://ws.chat.false.tel/ws/v3**', socket => {
        socket.send(JSON.stringify({version: 3, type: 'presence.snapshot', payload: {user_ids: []}}));
      });
      await context.route('https://auth.chat.false.tel/api/auth/v2/refresh', async route => {
        if (route.request().method() === 'OPTIONS') {
          await route.fulfill({status: 204, headers: cors});
          return;
        }
        refreshes++;
        expect(route.request().postDataJSON()).toEqual({browser_id: binding.browser_id, generation: binding.generation});
        await pending;
        const token = `x.${Buffer.from(JSON.stringify({sub: binding.subject})).toString('base64url')}.x`;
        const status = outcome === 'unauthorized' ? 401 : 200;
        await route.fulfill({status, headers: cors, json: status === 200 ? {access_token: token, token_type: 'Bearer', expires_in: 3600, browser_id: binding.browser_id, generation: binding.generation} : {error: 'unavailable'}});
      });
      await page.goto(`${origin}/`, {waitUntil: 'domcontentloaded'});
      await expect.poll(() => refreshes).toBe(1);
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      const spinner = page.locator('app-root-redirect .lds-ring');
      await expect(spinner).toBeVisible();
      for (const theme of ['dark-theme', 'light-theme']) {
        await page.evaluate(selected => {
          for (const element of [document.documentElement, document.body]) {
            element.classList.toggle('dark-theme', selected === 'dark-theme');
            element.classList.toggle('light-theme', selected === 'light-theme');
          }
        }, theme);
        for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 768}, {width: 390, height: 844}]) {
          await page.setViewportSize(viewport);
          const layout = await spinner.evaluate(node => {
            const rect = node.getBoundingClientRect();
            const content = document.querySelector('.app-content')!.getBoundingClientRect();
            const header = document.querySelector('app-header')!.getBoundingClientRect();
            const banner = document.querySelector('.offline-banner')?.getBoundingClientRect();
            const ringColor = getComputedStyle(node.firstElementChild!).borderTopColor;
            const canvasColor = getComputedStyle(document.querySelector('.app-shell')!).backgroundColor;
            const luminance = (color: string) => {
              const values = color.match(/\d+(?:\.\d+)?/g)!.slice(0, 3).map(Number).map(value => {
                const c = value / 255;
                return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
              });
              return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
            };
            const a = luminance(ringColor), b = luminance(canvasColor);
            return {dx: Math.abs((rect.left + rect.right - content.left - content.right) / 2), dy: Math.abs((rect.top + rect.bottom - content.top - content.bottom) / 2), contained: rect.left >= content.left && rect.right <= content.right && rect.top >= content.top && rect.bottom <= content.bottom, belowHeader: rect.top >= header.bottom, belowBanner: !banner || rect.top >= banner.bottom, bannerVisible: !!banner, noOverflow: document.documentElement.scrollWidth <= innerWidth, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05)};
          });
          expect(layout.dx, `${theme} ${viewport.width} horizontal center`).toBeLessThan(2);
          expect(layout.dy, `${theme} ${viewport.width} vertical center`).toBeLessThan(2);
          expect(layout.contained && layout.belowHeader && layout.belowBanner && layout.noOverflow).toBe(true);
          expect(layout.bannerVisible).toBe(outcome === 'unauthorized');
          expect(layout.contrast).toBeGreaterThanOrEqual(3);
          await page.screenshot({path: testInfo.outputPath(`root-loading-${outcome}-${theme}-${viewport.width}.png`)});
        }
      }
      const status = page.locator('app-root-redirect').getByRole('status');
      await expect(status).toBeVisible();
      await expect(status).toHaveText('Restoring session');
      await expect(status).toHaveAttribute('aria-live', 'polite');
      await expect(status).toHaveAttribute('aria-atomic', 'true');
      await expect(status.locator('.visually-hidden')).toHaveCSS('position', 'absolute');
      await page.emulateMedia({reducedMotion: 'reduce'});
      expect(await spinner.locator('div').first().evaluate(node => getComputedStyle(node).animationName)).toBe('none');
      release();
      await expect(page).toHaveURL(new RegExp(outcome === 'success' ? '/home$' : '/login$'));
      await expect(spinner).toHaveCount(0);
      if (outcome === 'success') {
        await expect(page.getByRole('heading', {name: 'Chats'})).toBeVisible();
        await expect(page.getByText('No conversations yet.')).toBeVisible();
        await expect(page.getByText('Could not load chats.')).toHaveCount(0);
        await expect.poll(() => ['/api/auth/me', '/api/auth/media-policy', '/api/auth/ws-ticket', '/api/chat/conversations', '/api/chat/groups'].every(path => homeRequests.has(path))).toBe(true);
      } else await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
      if (outcome === 'success') expect(refreshes).toBe(1);
      expect(pageErrors).toEqual([]);
    } finally {
      release();
      await page.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}

test('production root sends an anonymous browser to sign in without refreshing', async ({page, context}) => {
  const {server, origin} = await startProductionServer();
  let refreshes = 0;
  try {
    await context.route('https://*.chat.false.tel/**', route => {
      if (new URL(route.request().url()).pathname === '/api/auth/v2/refresh') refreshes++;
      return route.abort();
    });
    await page.goto(`${origin}/`);
    await expect(page).toHaveURL(`${origin}/login`);
    await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
    expect(refreshes).toBe(0);
  } finally {
    await page.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('production service worker renders the login app shell offline without caching private data', async ({page, context}, testInfo) => {
  const {server, origin} = await startProductionServer();
  try {
    await page.goto(`${origin}/login`);
    await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();

    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await expect.poll(() => page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
      }
      return urls.some(url => new URL(url).pathname === '/index.html') &&
        urls.some(url => /\.(js|css)$/.test(new URL(url).pathname));
    })).toBe(true);

    const cachedShell = await page.evaluate(async () => {
      const cacheNames = await caches.keys();
      const cachedUrls: string[] = [];
      for (const cacheName of cacheNames) {
        for (const request of await (await caches.open(cacheName)).keys()) cachedUrls.push(request.url);
      }
      return cachedUrls;
    });
    expect(cachedShell.some(url => new URL(url).pathname === '/index.html')).toBe(true);
    expect(cachedShell.some(url => /\.(js|css)$/.test(new URL(url).pathname))).toBe(true);

    const privateResponse = await page.evaluate(async () => {
      const response = await fetch('/api/private-probe');
      return await response.json() as {displayName: string};
    });
    expect(privateResponse.displayName).toBe(privateSentinel);

    const cachedContent = await page.evaluate(async () => {
      const cachedRequests: string[] = [];
      const cachedBodies: string[] = [];
      for (const cacheName of await caches.keys()) {
        const cache = await caches.open(cacheName);
        for (const request of await cache.keys()) {
          cachedRequests.push(request.url);
          const response = await cache.match(request);
          if (response) cachedBodies.push(await response.clone().text());
        }
      }
      return {cachedRequests, cachedBodies};
    });
    expect(cachedContent.cachedRequests.some(url => new URL(url).pathname.startsWith('/api/'))).toBe(false);
    expect(cachedContent.cachedBodies.join('\n')).not.toContain(privateSentinel);

    const previousDocumentTime = await page.evaluate(() => performance.timeOrigin);
    await context.setOffline(true);
    await expect(page.getByRole('status')).toHaveText('You’re offline. Zwei will reconnect when your connection returns.');
    const offlineBeforeReload = await page.evaluate(() => ({
      navigatorOnline: navigator.onLine,
      persistedOfflineSignal: sessionStorage.getItem('zwei.pwa.offline'),
    }));
    expect(offlineBeforeReload.persistedOfflineSignal).toBe('true');
    // Seed the restored-document case before app bootstrap; Chromium may emit
    // an online signal while replacing the offline document during reload.
    await page.addInitScript(() => sessionStorage.setItem('zwei.pwa.offline', 'true'));
    await page.reload();
    await expect.poll(() => page.evaluate(previousTime => performance.timeOrigin !== previousTime, previousDocumentTime)).toBe(true);
    await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
    await expect(page).toHaveURL(`${origin}/login`);
    await expect(page.getByRole('status')).toHaveText('You’re offline. Zwei will reconnect when your connection returns.');
    const offlineState = await page.evaluate(() => {
      const banner = document.querySelector<HTMLElement>('.offline-banner');
      const bounds = banner?.getBoundingClientRect();
      return {
        navigatorOnline: navigator.onLine,
        bannerVisible: Boolean(banner && bounds && bounds.width > 0 && bounds.height > 0 &&
          getComputedStyle(banner).display !== 'none' && getComputedStyle(banner).visibility === 'visible'),
        bounds: bounds ? {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, bottom: bounds.bottom} : null,
        route: location.pathname,
        controlled: navigator.serviceWorker.controller !== null,
      };
    });
    console.log('offline reload state', {beforeReload: offlineBeforeReload, afterReload: offlineState});
    expect(offlineState.navigatorOnline).toBe(true);
    expect(offlineState.bannerVisible).toBe(true);
    expect(offlineState.bounds).not.toBeNull();
    expect(offlineState.bounds?.width).toBeGreaterThan(0);
    expect(offlineState.bounds?.height).toBeGreaterThan(0);
    expect(offlineState.route).toBe('/login');
    expect(offlineState.controlled).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem('zwei.pwa.offline'))).toBe('true');
    const privateApiAvailableOffline = await page.evaluate(async () => {
      try {
        return (await fetch('/api/private-probe')).ok;
      } catch {
        return false;
      }
    });
    expect(privateApiAvailableOffline).toBe(false);
    for (const theme of ['dark-theme', 'light-theme']) {
      await page.evaluate(selectedTheme => {
        document.documentElement.classList.toggle('dark-theme', selectedTheme === 'dark-theme');
        document.documentElement.classList.toggle('light-theme', selectedTheme === 'light-theme');
        document.body.classList.toggle('dark-theme', selectedTheme === 'dark-theme');
        document.body.classList.toggle('light-theme', selectedTheme === 'light-theme');
      }, theme);
      for (const viewport of [
        {width: 2560, height: 1440},
        {width: 1440, height: 900},
        {width: 1024, height: 768},
        {width: 390, height: 844},
      ]) {
        await page.setViewportSize(viewport);
        const offlineLayout = await page.evaluate(() => {
          const banner = document.querySelector<HTMLElement>('.offline-banner');
          const bounds = banner?.getBoundingClientRect();
          return {
            statusVisible: Boolean(banner && getComputedStyle(banner).display !== 'none' &&
              getComputedStyle(banner).visibility === 'visible'),
            contained: Boolean(bounds && bounds.left >= 0 && bounds.right <= window.innerWidth),
            documentContained: document.documentElement.scrollWidth <= window.innerWidth,
          };
        });
        expect(offlineLayout, `${theme} offline banner layout at ${viewport.width}x${viewport.height}`).toEqual({
          statusVisible: true,
          contained: true,
          documentContained: true,
        });
      }
    }
    await page.setViewportSize({width: 1280, height: 720});
    await page.evaluate(() => {
      document.documentElement.classList.add('dark-theme');
      document.documentElement.classList.remove('light-theme');
      document.body.classList.add('dark-theme');
      document.body.classList.remove('light-theme');
    });
    await page.screenshot({path: testInfo.outputPath('pwa-offline-shell-dark.png'), fullPage: true});
    await page.evaluate(() => {
      document.documentElement.classList.add('light-theme');
      document.documentElement.classList.remove('dark-theme');
      document.body.classList.add('light-theme');
      document.body.classList.remove('dark-theme');
    });
    await page.screenshot({path: testInfo.outputPath('pwa-offline-shell-light.png'), fullPage: true});
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
