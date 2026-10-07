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

async function startProductionServer(): Promise<{server: Server; origin: string}> {
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (requestPath === '/api/private-probe') {
      response.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
      response.end(JSON.stringify({displayName: privateSentinel}));
      return;
    }

    const decodedPath = decodeURIComponent(requestPath);
    const normalizedPath = normalize(decodedPath).replace(/^([/\\])+/, '');
    const filePath = join(productionRoot, normalizedPath || 'index.html');
    const pathFromRoot = relative(productionRoot, filePath);
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
          response.end(await readFile(join(productionRoot, 'index.html')));
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
  return {server, origin: `http://localhost:${address.port}`};
}

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
