import {expect, Page, test} from '@playwright/test';
import {restoreSession, fixtureToken} from './session-helpers';

const password = 'Password123!';
const adminBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';

function uniqueEmail(name: string): string {
  return `e2e-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
}

function input(page: Page, name: string) {
  return page.locator(`[formControlName="${name}"]`);
}

function field(page: Page, name: string) {
  return page.locator('mat-form-field').filter({has: input(page, name)});
}

// Sample the browser-painted backdrop across each text line, not an assumed
// gradient stop. Hiding only the text preserves all background compositing.
async function renderedTextContrast(page: Page, selector: string): Promise<number> {
  const element = page.locator(selector).first();
  await element.scrollIntoViewIfNeeded();
  const metrics = await element.evaluate(node => {
    const style = getComputedStyle(node);
    let opacity = 1;
    for (let parent: Element | null = node; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
    const ranges: {left: number; top: number; right: number; bottom: number}[] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const rect of Array.from(range.getClientRects())) ranges.push({left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom});
    }
    return {color: style.color, opacity, ranges};
  });
  const style = await page.addStyleTag({content: `${selector} { color: transparent !important; text-shadow: none !important; }`});
  let screenshot: Buffer;
  try {
    screenshot = await page.screenshot({scale: 'css', animations: 'disabled'});
  } finally {
    await style.evaluate(node => node.remove());
  }
  return page.evaluate(async ({image, metrics}) => {
    const bytes = Uint8Array.from(atob(image), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context || !metrics.ranges.length) return 0;
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = colorCanvas.height = 1;
    const colorContext = colorCanvas.getContext('2d');
    if (!colorContext) return 0;
    colorContext.fillStyle = metrics.color;
    colorContext.fillRect(0, 0, 1, 1);
    const foreground = colorContext.getImageData(0, 0, 1, 1).data;
    const alpha = foreground[3] / 255 * metrics.opacity;
    const luminance = (channels: number[]) => channels.map(value => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    let minimum = Infinity;
    for (const rect of metrics.ranges) {
      if (rect.left < 0 || rect.top < 0 || rect.right > canvas.width || rect.bottom > canvas.height) return 0;
      for (let y = Math.ceil(rect.top); y < Math.floor(rect.bottom); y++) {
        for (let x = Math.ceil(rect.left); x < Math.floor(rect.right); x++) {
          const index = (y * canvas.width + x) * 4;
          const background = Array.from(pixels.slice(index, index + 3));
          const rendered = background.map((channel, i) => foreground[i] * alpha + channel * (1 - alpha));
          const bg = luminance(background), fg = luminance(rendered);
          minimum = Math.min(minimum, (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05));
        }
      }
    }
    return Number.isFinite(minimum) ? minimum : 0;
  }, {image: screenshot.toString('base64'), metrics});
}

// Compare painted outline pixels to their immediately adjacent painted backdrop
// on each side, including translucent ancestor surfaces and gradients.
async function renderedOutlineContrast(page: Page, selector: string): Promise<number> {
  const metrics = await page.locator(selector).evaluate(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, offset: parseFloat(style.outlineOffset), width: parseFloat(style.outlineWidth)};
  });
  const screenshot = await page.screenshot({scale: 'css', animations: 'disabled'});
  return page.evaluate(async ({image, metrics}) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(image), c => c.charCodeAt(0))], {type: 'image/png'}));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    context.drawImage(bitmap, 0, 0);
    const luminance = (values: number[]) => values.map(value => {
      const c = value / 255;
      return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [ .2126, .7152, .0722 ][index], 0);
    const pixel = (x: number, y: number): number | null => {
      x = Math.floor(x); y = Math.floor(y);
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
      return luminance(Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3)));
    };
    let minimum = Infinity;
    // Stay on the straight portions of rounded outlines, away from antialiased corners.
    for (const fraction of [0.4, 0.5, 0.6]) {
      const x = metrics.left + (metrics.right - metrics.left) * fraction;
      const y = metrics.top + (metrics.bottom - metrics.top) * fraction;
      const middle = metrics.offset + metrics.width / 2;
      const outside = metrics.offset + metrics.width + 1;
      for (const [ringX, ringY, adjacentX, adjacentY] of [
        [x, metrics.top - middle, x, metrics.top - outside],
        [x, metrics.bottom + middle, x, metrics.bottom + outside],
        [metrics.left - middle, y, metrics.left - outside, y],
        [metrics.right + middle, y, metrics.right + outside, y],
      ]) {
        const ring = pixel(ringX, ringY), adjacent = pixel(adjacentX, adjacentY);
        if (ring === null || adjacent === null) return 0;
        minimum = Math.min(minimum, (Math.max(ring, adjacent) + .05) / (Math.min(ring, adjacent) + .05));
      }
    }
    return minimum;
  }, {image: screenshot.toString('base64'), metrics});
}

async function register(page: Page, email: string, nickname = 'Test User', baseURL = ''): Promise<string> {
  const loginPayload = await fixtureToken(adminBase, adminEmail, password, 'E2E');
  const invitationResponse = await page.context().request.post(`${adminBase}/api/admin/invitations`, {
    headers: {Authorization: `${loginPayload.token_type} ${loginPayload.access_token}`},
    data: {email},
  });
  const invitationPayload = await invitationResponse.json() as {code: string};
  await page.goto(`${baseURL}/sign-up?invite=1&code=${encodeURIComponent(invitationPayload.code)}`);
  await input(page, 'email').fill(email);
  await input(page, 'firstName').fill('Test');
  await input(page, 'lastName').fill('User');
  await input(page, 'nickName').fill(nickname);
  await input(page, 'password').fill(password);
  await input(page, 'confirmPassword').fill(password);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/v2/register') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create account'}).click();
  const response = await responsePromise;
  if (response.status() !== 201) {
    throw new Error(`registration failed: ${response.status()} ${await response.text()}`);
  }
  const payload = await response.json() as {access_token?: string};
  if (!payload.access_token) {
    throw new Error('registration response did not include an access token');
  }
  await expect(page).toHaveURL(/\/home$/);
  return payload.access_token;
}

async function openProfile(page: Page): Promise<void> {
  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: 'Profile', exact: true}).click();
}

async function login(page: Page, email: string, value = password): Promise<void> {
  await page.goto('/login');
  await input(page, 'email').fill(email);
  await input(page, 'password').fill(value);
  await page.getByRole('button', {name: 'Sign in'}).click();
}

test('same-device tabs serialize push enable before account-scoped disable and retain browser subscription', async ({browser}, testInfo) => {
  const base = process.env.BASE_URL ?? 'https://chat.localhost';
  const context = await browser.newContext({ignoreHTTPSErrors: true});
  try {
    await context.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', {configurable: true, get: () => 'granted'});
      const subscription = {
        endpoint: 'https://fcm.googleapis.com/send/e2e-subscription',
        options: {applicationServerKey: Uint8Array.from(atob('B'.repeat(87) + '='), c => c.charCodeAt(0)).buffer},
        toJSON: () => ({endpoint: 'https://fcm.googleapis.com/send/e2e-subscription', keys: {p256dh: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', auth: 'AAAAAAAAAAAAAAAAAAAAAA'}}),
        unsubscribe: async () => { throw new Error('shared browser subscription must not be removed'); },
      };
      Object.defineProperty(PushManager.prototype, 'getSubscription', {configurable: true, value: async () => subscription});
    });
    await context.route('**/api/auth/push/vapid-public-key', route => route.fulfill({status: 200, json: {public_key: 'B'.repeat(87)}}));
    const first = await context.newPage();
    await register(first, uniqueEmail('push-tabs'), 'Push tabs', base);
    await openProfile(first);
    await first.getByRole('radio', {name: /Notifications and sounds/}).click();
    const checkbox = (page: Page) => page.getByRole('checkbox', {name: 'Enable push notifications on this browser'});
    await expect(checkbox(first)).toHaveJSProperty('indeterminate', true);
    await checkbox(first).check();
    await expect(first.getByRole('status').filter({hasText: 'Push notifications are enabled on this browser.'})).toBeVisible();
    const second = await context.newPage();
    await restoreSession(second, () => second.goto(`${base}/profile`), 'profile', await first.evaluate(() => localStorage.getItem('zwei.intended-session')));
    await expect(checkbox(second)).toHaveJSProperty('indeterminate', true);
    await checkbox(second).check();
    await expect(second.getByRole('status').filter({hasText: 'Push notifications are enabled on this browser.'})).toBeVisible();

    // Pause the actual save while it owns the browser-wide Web Lock. A disable
    // from the other tab must not overtake it, even across independent facades.
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const saveStarted = new Promise<void>(resolve => { started = resolve; });
    await first.route('**/api/auth/push-subscription', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      started();
      await gate;
      await route.continue();
    });
    // Re-enroll on the first tab after a server-side disable, then race the
    // stale checked second tab's disable with that save.
    const firstDelete = first.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/push-subscription/current' && response.request().method() === 'DELETE');
    await checkbox(first).uncheck();
    expect((await firstDelete).status()).toBe(204);
    await expect(checkbox(first)).toHaveJSProperty('indeterminate', true);
    await checkbox(first).check();
    await saveStarted;
    let deleteSeen = false;
    second.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/auth/push-subscription/current') deleteSeen = true; });
    await checkbox(second).uncheck();
    await expect(second.getByRole('status').filter({hasText: 'Updating this browser…'})).toBeVisible();
    expect(deleteSeen).toBe(false);
    const secondDelete = second.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/push-subscription/current' && response.request().method() === 'DELETE');
    release();
    await expect.poll(() => deleteSeen).toBe(true);
    expect((await secondDelete).status()).toBe(204);
    await expect(checkbox(second)).toHaveJSProperty('indeterminate', true);
    await expect(second.getByRole('status').filter({hasText: 'Push registration for this account could not be confirmed'})).toBeVisible();
    await second.screenshot({path: testInfo.outputPath('push-tabs-disabled.png'), fullPage: true});
    await restoreSession(first, () => first.reload(), 'profile');
    await expect(checkbox(first)).toHaveJSProperty('indeterminate', true);
    expect(await first.evaluate(async () => !!(await (await navigator.serviceWorker.ready).pushManager.getSubscription()))).toBe(true);
  } finally {
    await context.close();
  }
});

test('profile push setup state stays contained across themes and target viewports', async ({page}, testInfo) => {
  const email = uniqueEmail('push-profile');
  const accessToken = await register(page, email, 'Push Profile User');
  const preference = await page.context().request.patch('/api/auth/me', {
    headers: {Authorization: `Bearer ${accessToken}`},
    data: {alert_mode: 'notifications'},
  });
  expect(preference.ok()).toBeTruthy();
  await restoreSession(page, () => page.goto('/profile'), 'profile');
  await expect(page.getByRole('heading', {name: 'Profile'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'This browser'})).toBeVisible();
  await expect(page.getByRole('status').filter({hasText: /Web Push is not supported|Notifications are blocked|Enable browser notifications|not currently registered|could not be confirmed|Push notifications are enabled/})).toHaveCount(1);

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(selected => {
      document.documentElement.classList.toggle('dark-theme', selected === 'dark');
      document.documentElement.classList.toggle('light-theme', selected === 'light');
      document.body.classList.toggle('dark-theme', selected === 'dark');
      document.body.classList.toggle('light-theme', selected === 'light');
    }, theme);
    for (const viewport of [
      {width: 2560, height: 1440}, {width: 1440, height: 900},
      {width: 1024, height: 768}, {width: 390, height: 844},
    ]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>('.profile-card');
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.profile-card button'));
        const rects = buttons.map(button => button.getBoundingClientRect());
        return {
          documentContained: document.documentElement.scrollWidth <= window.innerWidth,
          cardContained: Boolean(card && card.getBoundingClientRect().left >= 0 && card.getBoundingClientRect().right <= window.innerWidth),
          buttonsContained: rects.every(rect => rect.left >= 0 && rect.right <= window.innerWidth),
          buttonsOverlap: rects.some((rect, index) => rects.slice(index + 1).some(other => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top)),
          pushStateVisible: Boolean(document.querySelector('[aria-labelledby="push-settings-title"]')),
        };
      });
      expect(layout, `${theme} Profile push state at ${viewport.width}x${viewport.height}`).toEqual({
        documentContained: true, cardContained: true, buttonsContained: true, buttonsOverlap: false, pushStateVisible: true,
      });
      await page.screenshot({path: testInfo.outputPath(`profile-push-${theme}-${viewport.width}x${viewport.height}.png`), fullPage: true});
      const scrolledLayout = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('.profile-page');
        if (!scroller) return null;
        scroller.scrollTop = scroller.scrollHeight;
        const push = document.querySelector<HTMLElement>('[aria-labelledby="push-settings-title"]');
        const bounds = push?.getBoundingClientRect();
        return {
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          scrollWidth: scroller.scrollWidth,
          clientWidth: scroller.clientWidth,
          pushVisible: Boolean(bounds && bounds.top >= 0 && bounds.bottom <= window.innerHeight),
          horizontalContainment: scroller.scrollWidth <= scroller.clientWidth && document.documentElement.scrollWidth <= window.innerWidth,
        };
      });
      expect(scrolledLayout, `${theme} Profile push state scrolled at ${viewport.width}x${viewport.height}`).not.toBeNull();
      expect(scrolledLayout?.pushVisible).toBe(true);
      expect(scrolledLayout?.horizontalContainment).toBe(true);
      await page.screenshot({path: testInfo.outputPath(`profile-push-${theme}-${viewport.width}x${viewport.height}-scrolled.png`), fullPage: true});
    }
  }
});

test('profile push permission states preserve account preference and stay contained', async ({browser}, testInfo) => {
  // Four browser contexts each exercise ten viewport/theme combinations,
  // including focus, tooltip animation, geometry and screenshot assertions.
  test.setTimeout(90_000);
  const chatBase = process.env.BASE_URL ?? 'https://chat.localhost';
  const origin = new URL(chatBase).origin;
  const cases = [
    {state: 'not-enrolled', permission: 'granted' as const},
    {state: 'denied', permission: 'denied' as const},
    {state: 'unverified', permission: 'granted' as const},
    {state: 'enabled', permission: 'granted' as const},
  ];

  for (const {state, permission} of cases) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      permissions: permission === 'granted' ? ['notifications'] : [],
      hasTouch: true,
      viewport: {width: 1440, height: 900},
    });
    try {
      const page = await context.newPage();
      if (permission === 'granted') {
        await context.grantPermissions(['notifications'], {origin});
      } else {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Browser.setPermission', {
          permission: {name: 'notifications'},
          setting: 'denied',
          origin,
        });
        await cdp.detach();
      }
      // Headless Chromium in this Docker setup reports notifications as denied
      // despite per-context grants; pin the exposed state before any navigation.
      await context.addInitScript(({permissionState, subscribed}: {permissionState: NotificationPermission; subscribed: boolean}) => {
        if (typeof Notification !== 'undefined') {
          Object.defineProperty(Notification, 'permission', {configurable: true, get: () => permissionState});
        }
        // SwPush's initial subscription observable reads PushManager.getSubscription().
        // Model a browser subscription without contacting a push provider.
        if (subscribed && typeof PushManager !== 'undefined') {
          Object.defineProperty(PushManager.prototype, 'getSubscription', {
            configurable: true,
            value: async () => ({
              endpoint: 'https://push.example.test/subscription',
              options: {applicationServerKey: Uint8Array.from(atob('B'.repeat(87) + '='), c => c.charCodeAt(0)).buffer},
              toJSON: () => ({endpoint: 'https://push.example.test/subscription', keys: {p256dh: 'test-key', auth: 'test-auth'}}),
              unsubscribe: async () => true,
            }),
          });
        }
      }, {permissionState: permission, subscribed: state === 'enabled' || state === 'unverified'});

      const accessToken = await register(page, uniqueEmail(`push-${state}`), `Push ${state}`, chatBase);
      expect(await page.evaluate(() => Notification.permission), `${state}: notification permission after registration`).toBe(permission);
      const preference = await context.request.patch(`${origin}/api/auth/me`, {
        headers: {Authorization: `Bearer ${accessToken}`},
        data: {alert_mode: 'notifications'},
      });
      expect(preference.ok(), `${state}: save account notification preference`).toBeTruthy();
      if (state === 'enabled' || state === 'unverified') {
        await page.route('**/api/auth/push/vapid-public-key', route => route.fulfill({status: 200, json: {public_key: 'B'.repeat(87)}}));
        await page.route('**/api/auth/push-subscription/verify', route => route.fulfill({status: 200, json: {matches: state === 'enabled'}}));
      }
      await restoreSession(page, () => page.goto(`${chatBase}/profile`), 'profile');
      await expect(page.getByRole('heading', {name: 'This browser'})).toBeVisible();
      const pushCheckbox = page.getByRole('checkbox', {name: 'Enable push notifications on this browser'});

      if (state === 'not-enrolled') {
        await expect(page.getByRole('status').filter({hasText: 'This browser is not currently registered to receive push notifications.'})).toBeVisible();
        await expect(pushCheckbox).not.toBeChecked();
      } else if (state === 'enabled') {
        const enabledStatus = page.getByRole('status').filter({hasText: 'Push notifications are enabled on this browser.'});
        await expect(enabledStatus).toHaveCount(1);
        await expect(enabledStatus).toBeVisible();
        await expect(pushCheckbox).toBeChecked();
      } else if (state === 'unverified') {
        await expect(page.getByRole('status').filter({hasText: 'Push registration for this account could not be confirmed'})).toBeVisible();
        await expect(pushCheckbox).toHaveJSProperty('indeterminate', true);
        const disable = page.getByRole('button', {name: 'Disable push for this account'});
        await expect(disable).toBeVisible();
      } else {
        await expect(page.getByRole('status').filter({hasText: 'Notifications are blocked. Allow them in this browser’s site settings, then re-enable here.'})).toBeVisible();
        await expect(pushCheckbox).toBeDisabled();
      }
      await expect(page.getByRole('radio', {name: /Notifications and sounds/})).toHaveAttribute('aria-checked', 'true');

      if (state === 'not-enrolled') {
        let releaseVapidResponse!: () => void;
        const vapidResponseGate = new Promise<void>(resolve => { releaseVapidResponse = resolve; });
        let requestStarted!: () => void;
        const vapidRequestStarted = new Promise<void>(resolve => { requestStarted = resolve; });
        await page.route('**/api/auth/push/vapid-public-key', async route => {
          requestStarted();
          await vapidResponseGate;
          await route.fulfill({status: 503, contentType: 'application/json', body: '{}'});
        });
        await pushCheckbox.check();
        await vapidRequestStarted;
        await expect(pushCheckbox).toBeDisabled();
        await expect(page.getByRole('status').filter({hasText: 'Updating this browser…'})).toBeVisible();
        releaseVapidResponse();
        await expect(pushCheckbox).toBeEnabled();
        await expect(pushCheckbox).not.toBeChecked();
        await expect(page.getByRole('alert').filter({hasText: 'Could not enable notifications'})).toBeVisible();
        await page.unroute('**/api/auth/push/vapid-public-key');
      }

      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate(selected => {
          document.documentElement.classList.toggle('dark-theme', selected === 'dark');
          document.documentElement.classList.toggle('light-theme', selected === 'light');
          document.body.classList.toggle('dark-theme', selected === 'dark');
          document.body.classList.toggle('light-theme', selected === 'light');
        }, theme);
        for (const viewport of [
          {width: 1032, height: 646}, {width: 2560, height: 1440}, {width: 1440, height: 900},
          {width: 1024, height: 768}, {width: 390, height: 844},
        ]) {
          await page.setViewportSize(viewport);
          const layout = await page.evaluate(() => {
            const card = document.querySelector<HTMLElement>('.profile-card');
            const pushState = document.querySelector<HTMLElement>('[aria-labelledby="push-settings-title"]');
            const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.profile-card button'));
            const rects = buttons.map(button => button.getBoundingClientRect());
            const cardRect = card?.getBoundingClientRect();
            const cta = pushState?.querySelector<HTMLInputElement>('input[type="checkbox"]');
            const ctaRect = cta?.getBoundingClientRect();
            const pushLabel = pushState?.querySelector<HTMLElement>('label');
            const pushStatus = pushState?.querySelector<HTMLElement>('[role="status"]');
            const pushRect = pushState?.getBoundingClientRect();
            const containedInPush = (element: HTMLElement | null | undefined): boolean => {
              if (!element || !pushRect) return false;
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && rect.left >= pushRect.left && rect.right <= pushRect.right && rect.top >= pushRect.top && rect.bottom <= pushRect.bottom && element.scrollWidth <= element.clientWidth;
            };
            const mediaRow = document.querySelector<HTMLElement>('.media-disclosure-row');
            const infoButton = document.querySelector<HTMLButtonElement>('.media-info-button');
            const mediaCopy = mediaRow?.querySelector('p');
            const infoRect = infoButton?.getBoundingClientRect();
            const copyRect = mediaCopy?.getBoundingClientRect();
            return {
              noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
              cardContained: Boolean(cardRect && cardRect.left >= 0 && cardRect.right <= window.innerWidth),
              stateContained: Boolean(cardRect && pushState && pushState.getBoundingClientRect().left >= cardRect.left && pushState.getBoundingClientRect().right <= cardRect.right),
              mediaRowContained: Boolean(cardRect && mediaRow && mediaRow.getBoundingClientRect().left >= cardRect.left && mediaRow.getBoundingClientRect().right <= cardRect.right),
              mediaInfoContained: Boolean(cardRect && infoButton && infoButton.getBoundingClientRect().left >= cardRect.left && infoButton.getBoundingClientRect().right <= cardRect.right),
              mediaCopyAndInfoDoNotOverlap: Boolean(infoRect && copyRect && (copyRect.right <= infoRect.left || infoRect.right <= copyRect.left || copyRect.bottom <= infoRect.top || infoRect.bottom <= copyRect.top)),
              pushLabelContained: containedInPush(pushLabel),
              pushStatusContained: containedInPush(pushStatus),
              buttonsContained: rects.every(rect => Boolean(cardRect && rect.left >= cardRect.left && rect.right <= cardRect.right)),
              buttonsDoNotOverlap: rects.every((rect, index) => rects.slice(index + 1).every(other => rect.right <= other.left || rect.left >= other.right || rect.bottom <= other.top || rect.top >= other.bottom)),
              checkboxContained: Boolean(ctaRect && cardRect && ctaRect.left >= cardRect.left && ctaRect.right <= cardRect.right && ctaRect.width > 0 && ctaRect.height > 0),
            };
          });
          expect(layout, `${state} ${theme} Profile at ${viewport.width}x${viewport.height}`).toEqual({
            noHorizontalOverflow: true,
            cardContained: true,
            stateContained: true,
            mediaRowContained: true,
            mediaInfoContained: true,
            mediaCopyAndInfoDoNotOverlap: true,
            pushLabelContained: true,
            pushStatusContained: true,
            buttonsContained: true,
            buttonsDoNotOverlap: true,
            checkboxContained: true,
          });
          expect(await renderedTextContrast(page, '[aria-labelledby="media-settings-title"] .media-preference'), `${state} ${theme} inline-media label contrast at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(4.5);
          expect(await renderedTextContrast(page, '.media-disclosure-row p'), `${state} ${theme} inline-media disclosure copy contrast at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(4.5);
          expect(await renderedTextContrast(page, '[aria-labelledby="push-settings-title"] label'), `${state} ${theme} push checkbox label contrast at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(4.5);
          expect(await renderedTextContrast(page, '[aria-labelledby="push-settings-title"] [role="status"]'), `${state} ${theme} push status contrast at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(4.5);
          if (state === 'unverified') {
            expect(await renderedTextContrast(page, '[aria-labelledby="push-settings-title"] button'), `${state} ${theme} disable push action contrast at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(4.5);
          }
          await page.locator('[aria-labelledby="push-settings-title"]').scrollIntoViewIfNeeded();
          const expectedStatus = state === 'denied'
            ? 'Notifications are blocked.'
            : state === 'enabled'
              ? 'Push notifications are enabled on this browser.'
              : state === 'unverified' ? 'Push registration for this account could not be confirmed' : 'This browser is not currently registered';
          await expect(page.getByRole('status').filter({hasText: expectedStatus})).toBeInViewport();
          if (state === 'enabled') {
            await expect(page.getByRole('status').filter({hasText: expectedStatus})).toHaveCount(1);
          }
          await expect(pushCheckbox).toBeInViewport();
          // A tooltip from the preceding viewport can still be fading out.
          await page.keyboard.press('Escape');
          await expect(page.locator('.cdk-overlay-container .profile-media-disclosure-tooltip')).toHaveCount(0);
          if (state !== 'denied') {
            await page.getByRole('radio', {name: /Notifications and sounds/}).focus();
            await page.keyboard.press('Tab');
            await expect(pushCheckbox).toBeFocused();
            await expect(pushCheckbox).toHaveCSS('outline-style', 'solid');
            await expect(pushCheckbox).toHaveCSS('outline-width', '3px');
            expect(await pushCheckbox.evaluate(element => element.matches(':focus-visible'))).toBe(true);
            const focusContrast = await renderedOutlineContrast(page, '[aria-labelledby="push-settings-title"] input[type="checkbox"]');
            expect(focusContrast, `${state} ${theme} checkbox focus contrast`).toBeGreaterThanOrEqual(3);
            if (state === 'unverified') {
              const disable = page.getByRole('button', {name: 'Disable push for this account'});
              await page.keyboard.press('Tab');
              await expect(disable).toBeFocused();
              expect(await disable.evaluate(element => element.matches(':focus-visible'))).toBe(true);
              await expect(disable).toHaveCSS('outline-style', 'solid');
              await expect(disable).toHaveCSS('outline-width', '3px');
              const clearance = await disable.evaluate(button => {
                const label = button.parentElement?.querySelector('label');
                if (!label) return -1;
                const style = getComputedStyle(button);
                return button.getBoundingClientRect().top - label.getBoundingClientRect().bottom - parseFloat(style.outlineOffset) - parseFloat(style.outlineWidth);
              });
              expect(clearance, `${state} ${theme} disable focus ring clears checkbox label`).toBeGreaterThanOrEqual(1);
              expect(await renderedOutlineContrast(page, '[aria-labelledby="push-settings-title"] button'), `${state} ${theme} disable push focus contrast`).toBeGreaterThanOrEqual(3);
            }
          }
          await page.screenshot({path: testInfo.outputPath(`profile-push-${state}-${theme}-${viewport.width}x${viewport.height}-focus.png`), fullPage: true});
          const infoButton = page.getByRole('button', {name: 'GIPHY loading privacy details'});
          const checkbox = page.getByRole('checkbox', {name: 'Automatically load approved GIPHY images and GIFs'});
          await expect(checkbox).not.toBeChecked();
          await page.getByRole('radio', {name: /Notifications and sounds/}).focus();
          if (state !== 'denied') await page.keyboard.press('Tab');
          if (state === 'unverified') await page.keyboard.press('Tab');
          await page.keyboard.press('Tab');
          await expect(infoButton).toBeFocused();
          await expect(infoButton).toHaveCSS('outline-style', 'solid');
          await expect(infoButton).toHaveCSS('outline-width', '3px');
          const disclosure = 'When enabled, approved GIPHY images and GIFs in messages load automatically. Your browser contacts GIPHY, which may receive your IP address and request timing. Share-page links still require you to open GIPHY.';
          const describedBy = await infoButton.getAttribute('aria-describedby');
          expect(describedBy, 'the focused info control exposes an accessible description').toBeTruthy();
          const accessibleDisclosure = page.locator(`[id="${describedBy}"]`);
          await expect(accessibleDisclosure).toHaveText(disclosure);
          const tooltip = page.locator('.cdk-overlay-container .profile-media-disclosure-tooltip');
          await expect(tooltip).toBeVisible();
          await expect(tooltip).toHaveText(disclosure);
          await expect(tooltip).toHaveCSS('opacity', '1');
          const tooltipRect = await tooltip.boundingBox();
          expect(tooltipRect, `${theme} tooltip at ${viewport.width}x${viewport.height} is rendered`).not.toBeNull();
          if (!tooltipRect) throw new Error('Expected the privacy disclosure tooltip to render.');
          expect(tooltipRect.x, `${theme} tooltip left at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(0);
          expect(tooltipRect.x + tooltipRect.width, `${theme} tooltip right at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(viewport.width);
          expect(tooltipRect.y, `${theme} tooltip top at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(0);
          expect(tooltipRect.y + tooltipRect.height, `${theme} tooltip bottom at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(viewport.height);
          const pushActionRect = await pushCheckbox.boundingBox();
          const mediaCheckboxRect = await checkbox.boundingBox();
          if (pushActionRect && mediaCheckboxRect) {
            const overlaps = (rect: {x: number; y: number; width: number; height: number}) =>
              tooltipRect.x < rect.x + rect.width && tooltipRect.x + tooltipRect.width > rect.x &&
              tooltipRect.y < rect.y + rect.height && tooltipRect.y + tooltipRect.height > rect.y;
            expect(overlaps(pushActionRect), `${theme} tooltip does not cover the browser push action at ${viewport.width}x${viewport.height}`).toBe(false);
            expect(overlaps(mediaCheckboxRect), `${theme} tooltip does not cover the media preference at ${viewport.width}x${viewport.height}`).toBe(false);
          }
          await infoButton.hover();
          await expect(tooltip).toBeVisible();
          await infoButton.click();
          await expect(checkbox).not.toBeChecked();
          await page.screenshot({path: testInfo.outputPath(`profile-push-${state}-${theme}-${viewport.width}x${viewport.height}.png`), fullPage: true});
        }
      }
      if (state === 'unverified') {
        const disable = page.getByRole('button', {name: 'Disable push for this account'});
        const removal = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/push-subscription/current' && response.request().method() === 'DELETE');
        await disable.click();
        expect((await removal).ok()).toBeTruthy();
        await expect(pushCheckbox).not.toBeChecked();
        await expect(pushCheckbox).toHaveJSProperty('indeterminate', true);
      }
    } finally {
      await context.close();
    }
  }
});

test('profile recovers from a browser push service that never responds', async ({browser}) => {
  const chatBase = process.env.BASE_URL ?? 'https://chat.localhost';
  const origin = new URL(chatBase).origin;
  const context = await browser.newContext({ignoreHTTPSErrors: true, permissions: ['notifications']});
  try {
    const page = await context.newPage();
    await context.grantPermissions(['notifications'], {origin});
    await context.addInitScript(() => {
      if (typeof Notification !== 'undefined') {
        Object.defineProperty(Notification, 'permission', {configurable: true, get: () => 'granted'});
      }
      if (typeof PushManager !== 'undefined') {
        Object.defineProperty(PushManager.prototype, 'subscribe', {
          configurable: true,
          value: () => {
            const scope = window as Window & {__pushSubscribeCallCount?: number};
            scope.__pushSubscribeCallCount = (scope.__pushSubscribeCallCount ?? 0) + 1;
            return new Promise<PushSubscription>(() => undefined);
          },
        });
      }
    });
    const accessToken = await register(page, uniqueEmail('push-timeout'), 'Push timeout', chatBase);
    const preference = await context.request.patch(`${origin}/api/auth/me`, {
      headers: {Authorization: `Bearer ${accessToken}`},
      data: {alert_mode: 'notifications'},
    });
    expect(preference.ok(), 'save account notification preference').toBeTruthy();
    await page.route('**/api/auth/push/vapid-public-key', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({public_key: 'B'.repeat(87)}),
    }));
    await restoreSession(page, () => page.goto(`${chatBase}/profile`), 'profile');
    await expect(page.getByRole('heading', {name: 'This browser'})).toBeVisible();
    await page.clock.install();
    const enabling = page.getByRole('checkbox', {name: 'Enable push notifications on this browser'});
    await enabling.check();
    await expect(enabling).toBeDisabled();
    await expect(page.getByRole('status').filter({hasText: 'Updating this browser…'})).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as Window & {__pushSubscribeCallCount?: number}).__pushSubscribeCallCount ?? 0)).toBe(1);
    await page.clock.fastForward(25_000);
    const timeoutMessage = page.getByRole('alert').filter({hasText: 'This browser’s push service did not respond'});
    await expect(timeoutMessage).toContainText('Safari or Google Chrome');
    const retry = enabling;
    await expect(retry).toBeEnabled();
    await expect(retry).not.toBeChecked();
    await expect(page.getByRole('status').filter({hasText: 'Updating this browser…'})).toHaveCount(0);
    await retry.check();
    await expect.poll(() => page.evaluate(() => (window as Window & {__pushSubscribeCallCount?: number}).__pushSubscribeCallCount ?? 0)).toBe(2);
  } finally {
    await context.close();
  }
});

async function assertAccountMenuContrast(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const metrics = await page.getByRole('menu').evaluate(async menu => {
    const panel = menu.closest<HTMLElement>('.mat-mdc-menu-panel') ?? menu;
    const overlay = panel.closest<HTMLElement>('.cdk-overlay-pane') ?? panel;
    await Promise.all(overlay.getAnimations({subtree: true}).map(animation => animation.finished.catch(() => undefined)));
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const renderedOpacity = (): number => {
      let opacity = 1;
      for (let ancestor: HTMLElement | null = panel; ancestor; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
      return opacity;
    };
    const deadline = performance.now() + 2_000;
    while (renderedOpacity() < .999 && performance.now() < deadline) await frame();
    if (renderedOpacity() < .999) throw new Error(`Account menu did not settle at full opacity: ${renderedOpacity()}`);
    await frame();
    await frame();
    const surface = panel;
    const parse = (value: string): [number, number, number, number] => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`Unexpected computed color: ${value}`);
      const alpha = value.startsWith('rgba(') ? Number(value.match(/[\d.]+/g)?.[3] ?? 1) : 1;
      return [Number(channels[0]), Number(channels[1]), Number(channels[2]), alpha];
    };
    const luminance = (color: [number, number, number, number]) => color.slice(0, 3).map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const background = parse(getComputedStyle(surface).backgroundColor);
    const items = Array.from(menu.querySelectorAll<HTMLElement>('.mat-mdc-menu-item')).filter(item => item.getBoundingClientRect().height > 0);
    const identityRows = Array.from(menu.querySelectorAll<HTMLElement>('.account-menu-name, .account-menu-email')).filter(item => item.getBoundingClientRect().height > 0);
    const composite = (foreground: [number, number, number, number], backdrop: [number, number, number, number]): [number, number, number, number] => {
      const alpha = foreground[3] + backdrop[3] * (1 - foreground[3]);
      return [0, 1, 2].map(index => alpha === 0 ? 0 : (foreground[index] * foreground[3] + backdrop[index] * backdrop[3] * (1 - foreground[3])) / alpha).concat(alpha) as [number, number, number, number];
    };
    const contrast = (foreground: [number, number, number, number], backdrop: [number, number, number, number]) => {
      const rendered = composite(foreground, backdrop);
      const foregroundLuminance = luminance(rendered);
      const backgroundLuminance = luminance(backdrop);
      return {renderedForeground: rendered, renderedBackground: backdrop, contrast: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05)};
    };
    return {
      surface: getComputedStyle(surface).backgroundColor,
      surfaceAlpha: background[3],
      renderedOpacity: renderedOpacity(),
      panelClasses: Array.from(surface.classList),
      items: items.map(item => {
        const text = item.querySelector<HTMLElement>('.mat-mdc-menu-item-text') ?? item;
        const foreground = parse(getComputedStyle(text).color);
        let effectiveOpacity = 1;
        for (let ancestor: HTMLElement | null = text; ancestor && ancestor !== surface; ancestor = ancestor.parentElement) {
          effectiveOpacity *= Number(getComputedStyle(ancestor).opacity);
        }
        effectiveOpacity *= foreground[3];
        const effectiveForeground = foreground.slice(0, 3).map((channel, index) => channel * effectiveOpacity + background[index] * (1 - effectiveOpacity)) as [number, number, number];
        const bgLuminance = luminance(background);
        const fgLuminance = luminance(effectiveForeground);
        return {label: item.innerText.trim(), disabled: item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true', color: getComputedStyle(text).color, opacity: effectiveOpacity, effectiveForeground, contrast: (Math.max(bgLuminance, fgLuminance) + .05) / (Math.min(bgLuminance, fgLuminance) + .05)};
      }),
      identities: identityRows.map(item => {
        const text = item.querySelector<HTMLElement>('.mat-mdc-menu-item-text') ?? item;
        const color = parse(getComputedStyle(text).color);
        let opacity = 1;
        for (let ancestor: HTMLElement | null = text; ancestor && ancestor !== surface; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
        color[3] *= opacity;
        const itemBackground = parse(getComputedStyle(item).backgroundColor);
        const renderedBackground = composite(itemBackground, background);
        const metrics = contrast(color, renderedBackground);
        return {label: item.innerText.trim(), disabled: item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true', color: getComputedStyle(text).color, opacity, ...metrics};
      }),
    };
  });
  expect(await page.locator('html').evaluate(element => element.classList.contains('dark-theme'))).toBe(theme === 'dark');
  expect(metrics.panelClasses).toContain(theme === 'dark' ? 'account-menu-panel-dark' : 'account-menu-panel-light');
  expect(metrics.surface, `${theme} account-menu surface ${JSON.stringify(metrics.panelClasses)}`).toBe(theme === 'dark' ? 'rgb(38, 53, 70)' : 'rgb(255, 255, 255)');
  expect(metrics.surface).not.toBe('rgba(0, 0, 0, 0)');
  expect(metrics.surfaceAlpha, `${theme} account menu surface alpha`).toBe(1);
  expect(metrics.renderedOpacity, `${theme} account menu opacity after settling`).toBe(1);
  expect(metrics.items.length).toBeGreaterThan(0);
  expect(metrics.identities).toHaveLength(2);
  for (const identity of metrics.identities) {
    expect(identity.disabled, `${theme} account identity must be disabled: ${JSON.stringify(identity)}`).toBeTruthy();
    expect(identity.opacity, `${theme} account identity rendered opacity ${JSON.stringify(identity)}`).toBe(1);
    expect(identity.contrast, `${theme} composited account identity contrast ${JSON.stringify(identity)}`).toBeGreaterThanOrEqual(4.5);
  }
  const disabledItems = metrics.items.filter(item => item.disabled);
  const normalItems = metrics.items.filter(item => !item.disabled);
  expect(disabledItems.length, `${theme} account menu should expose disabled identity rows`).toBeGreaterThanOrEqual(2);
  expect(normalItems.length, `${theme} account menu should expose normal actions`).toBeGreaterThan(0);
  for (const item of metrics.items) expect(item.contrast, `${theme} effective contrast ${JSON.stringify(item)} on ${metrics.surface}`).toBeGreaterThanOrEqual(4.5);
  for (const item of disabledItems) expect(item.opacity, `${theme} disabled account text must remain fully opaque: ${JSON.stringify(item)}`).toBe(1);
}

test('serves the browser security headers', async ({request}) => {
  const response = await request.get('/');

  expect(response.ok()).toBeTruthy();
  const contentSecurityPolicy = response.headers()['content-security-policy'];
  expect(contentSecurityPolicy).toContain("default-src 'self'");
  expect(contentSecurityPolicy).not.toContain('fonts.googleapis.com');
  expect(contentSecurityPolicy).not.toContain('fonts.gstatic.com');
  const imageSources = contentSecurityPolicy.split(';').find(directive => directive.trim().startsWith('img-src'))?.trim().split(/\s+/) ?? [];
  const approvedGiphySources = ['media.giphy.com', 'media0.giphy.com', 'media1.giphy.com', 'media2.giphy.com', 'media3.giphy.com', 'media4.giphy.com'].map(host => `https://${host}`);
  expect(imageSources).toEqual(['img-src', "'self'", 'data:', ...approvedGiphySources]);
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['x-frame-options']).toBe('DENY');
  expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(response.headers()['permissions-policy']).toContain('camera=()');
  expect(response.headers()['permissions-policy']).toContain('microphone=(self)');
});

test('publishes raster PWA icons for browser installation', async ({request}) => {
  const manifestResponse = await request.get('/manifest.webmanifest');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json() as {icons: Array<{src: string; sizes: string; type: string}>};

  expect(manifest.icons.some(icon => icon.src === 'assets/zwei-app-icon-192.png' && icon.sizes === '192x192' && icon.type === 'image/png')).toBeTruthy();
  expect(manifest.icons.some(icon => icon.src === 'assets/zwei-app-icon-512.png' && icon.sizes === '512x512' && icon.type === 'image/png')).toBeTruthy();
  for (const icon of manifest.icons) {
    const response = await request.get(`/${icon.src}`);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()['content-type']).toContain('image/png');
  }
});

test('enforces authenticated chat limits through HTTPS', async ({page, request}) => {
  const initialConversationsResponse = page.waitForResponse(response =>
    response.url().includes('/api/chat/conversations') && response.request().method() === 'GET',
  );
  const accessToken = await register(page, uniqueEmail('chat-limit'), 'Chat Limit User');
  await initialConversationsResponse;
  const responses: Array<{status: number; retryAfter: string}> = [];

  for (let attempt = 0; attempt < 21; attempt += 1) {
    const response = await request.post('/api/chat/conversations', {
      headers: {Authorization: `Bearer ${accessToken}`},
      data: {other_user_id: '00000000-0000-0000-0000-000000000001'},
    });
    responses.push({status: response.status(), retryAfter: response.headers()['retry-after'] || ''});
    await response.body();
  }

  expect(responses.slice(0, 20).every(response => response.status === 404)).toBeTruthy();
  expect(responses[20]).toEqual({status: 429, retryAfter: '60'});
});

test('shows every registration and login validation state', async ({page}) => {
  const thirdPartyAssetRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('fonts.googleapis.com') || request.url().includes('fonts.gstatic.com')) thirdPartyAssetRequests.push(request.url());
  });
  await page.goto('/sign-up');
  await expect(page.getByRole('heading', {name: 'Create your account'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Account menu'})).toHaveCount(0);
  await expect(page.locator('zwei-icon').first().locator('svg')).toBeVisible();
  expect(thirdPartyAssetRequests).toEqual([]);
  await expect(page.getByRole('button', {name: 'Create account'})).toBeDisabled();

  for (const name of ['email', 'firstName', 'lastName', 'nickName', 'password', 'confirmPassword']) {
    await input(page, name).focus();
    await input(page, name).blur();
  }
  await expect(field(page, 'email').getByText('Email is required.')).toBeVisible();
  await expect(field(page, 'firstName').getByText('First name is required.')).toBeVisible();
  await expect(field(page, 'lastName').getByText('Last name is required.')).toBeVisible();
  await expect(field(page, 'nickName').getByText('Nickname is required.')).toBeVisible();
  await expect(field(page, 'password').getByText('Password is required.')).toBeVisible();
  await expect(field(page, 'confirmPassword').getByText('Please confirm your password.')).toBeVisible();

  await input(page, 'email').fill('not-an-email');
  await input(page, 'email').blur();
  await expect(field(page, 'email').getByText('Enter a valid email.')).toBeVisible();
  await input(page, 'email').fill(`${'a'.repeat(172)}@test.com`);
  await input(page, 'email').blur();
  await expect(field(page, 'email').getByText('Email is too long.')).toBeVisible();

  for (const name of ['firstName', 'lastName', 'nickName']) {
    await input(page, name).fill('A');
    await input(page, name).blur();
    await expect(field(page, name).getByText('Use at least 2 characters.')).toBeVisible();
    await input(page, name).fill('A'.repeat(61));
    await input(page, name).blur();
    await expect(field(page, name).getByText(/is too long\./)).toBeVisible();
  }

  await input(page, 'password').fill('short');
  await input(page, 'password').blur();
  await expect(field(page, 'password').getByText('Use at least 8 characters.')).toBeVisible();
  await input(page, 'password').fill('A'.repeat(65));
  await input(page, 'password').blur();
  await expect(field(page, 'password').getByText('Password is too long.')).toBeVisible();
  await input(page, 'password').fill(password);
  await input(page, 'confirmPassword').fill('Different1!');
  await input(page, 'confirmPassword').blur();
  await expect(page.getByText('Passwords do not match.')).toBeVisible();

  await page.getByRole('link', {name: 'Sign in'}).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('link', {name: 'Create one'}).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  for (const fieldName of ['email', 'firstName', 'lastName', 'nickName', 'password', 'confirmPassword']) {
    await expect(page.locator(`[formControlName="${fieldName}"]`)).toHaveValue('');
  }
  await page.getByRole('link', {name: 'Sign in'}).click();
  await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Sign in'})).toBeDisabled();
  await input(page, 'email').focus();
  await input(page, 'email').blur();
  await input(page, 'password').focus();
  await input(page, 'password').blur();
  await expect(field(page, 'email').getByText('Email is required.')).toBeVisible();
  await expect(field(page, 'password').getByText('Password is required.')).toBeVisible();
  await input(page, 'email').fill('not-an-email');
  await input(page, 'email').blur();
  await expect(field(page, 'email').getByText('Enter a valid email.')).toBeVisible();
});

test('uses the light auth theme when selected before the application starts', async ({page}) => {
  await page.addInitScript(() => localStorage.setItem('zwei_theme', 'light'));
  await page.goto('/login');

  await expect(page.locator('html')).toHaveClass(/light-theme/);
  await expect(page.locator('body')).toHaveClass(/light-theme/);
  await expect(page.locator('.auth-card')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.78)');
  await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toHaveCSS('color', 'rgb(23, 28, 43)');
});

test('keeps login text and fields readable in both themes across the acceptance viewports', async ({browser}, testInfo) => {
  const viewports = [
    {width: 2560, height: 1440},
    {width: 1440, height: 900},
    {width: 1024, height: 768},
    {width: 390, height: 844},
  ];
  for (const viewport of viewports) {
    for (const theme of ['light', 'dark'] as const) {
      const context = await browser.newContext({viewport});
      const page = await context.newPage();
      await page.addInitScript(selectedTheme => localStorage.setItem('zwei_theme', selectedTheme), theme);
      await page.goto('/login');
      await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
      await expect(page.getByRole('button', {name: 'Sign in'})).toBeDisabled();
      await expect(page.locator('html')).toHaveClass(new RegExp(`${theme}-theme`));
      const metrics = await page.evaluate(() => {
        const color = (value: string): [number, number, number, number] => {
          const parts = value.match(/[\d.]+/g)?.map(Number);
          if (!parts || parts.length < 3) throw new Error(`Unexpected color: ${value}`);
          return [parts[0], parts[1], parts[2], parts[3] ?? 1];
        };
        const composite = (front: [number, number, number, number], back: [number, number, number, number]): [number, number, number, number] => {
          const alpha = front[3] + back[3] * (1 - front[3]);
          return [0, 1, 2].map(index => alpha === 0 ? 0 : (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha).concat(alpha) as [number, number, number, number];
        };
        const luminance = (value: [number, number, number, number]) => value.slice(0, 3).map(channel => channel / 255)
          .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
          .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        const backgroundFor = (element: HTMLElement): [number, number, number, number] => {
          const page = document.querySelector<HTMLElement>('.auth-page');
          if (!page) throw new Error('Login page background is missing');
          let rendered = color(getComputedStyle(document.body).backgroundColor);
          const backdrop = color(getComputedStyle(page).backgroundColor);
          rendered = composite(backdrop, rendered);
          const gradient = getComputedStyle(page).backgroundImage;
          const rgbValues = gradient.match(/rgba?\([\d., ]+\)/g)?.map(color) ?? [];
          if (rgbValues.length > 0) rendered = composite(rgbValues[0], rendered);
          const layers: HTMLElement[] = [];
          for (let parent: HTMLElement | null = element; parent && parent !== page; parent = parent.parentElement) layers.push(parent);
          for (const layer of layers.reverse()) rendered = composite(color(getComputedStyle(layer).backgroundColor), rendered);
          return rendered;
        };
        const measure = (selector: string, large = false) => Array.from(document.querySelectorAll<HTMLElement>(selector))
          .filter(element => element.getBoundingClientRect().height > 0)
          .map(element => {
            const foreground = color(getComputedStyle(element).color);
            const background = backgroundFor(element);
            const renderedForeground = composite(foreground, background);
            const fg = luminance(renderedForeground);
            const bg = luminance(background);
            return {
              text: element.textContent?.trim() || element.getAttribute('placeholder') || selector,
              foreground: getComputedStyle(element).color,
              background: `rgba(${background.slice(0, 3).join(', ')}, ${background[3]})`,
              fontSize: getComputedStyle(element).fontSize,
              contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05),
              minimum: large || Number.parseFloat(getComputedStyle(element).fontSize) >= 24 ? 3 : 4.5,
            };
          });
        const page = document.querySelector<HTMLElement>('.auth-page');
        const card = document.querySelector<HTMLElement>('.auth-card');
        const field = document.querySelector<HTMLElement>('.auth-form mat-form-field');
        const submit = document.querySelector<HTMLElement>('.submit-button');
        return {
          text: [
            ...measure('.auth-intro .eyebrow'),
            ...measure('.auth-intro h1', true),
            ...measure('.auth-intro p'),
            ...measure('.auth-form .mat-mdc-floating-label'),
            ...measure('.auth-form input'),
            ...Array.from(document.querySelectorAll<HTMLInputElement>('.auth-form input')).filter(input => input.getAttribute('placeholder'))
              .map(input => {
                const style = getComputedStyle(input, '::placeholder');
                const foreground = color(style.color);
                const background = backgroundFor(input);
                const renderedForeground = composite(foreground, background);
                const fg = luminance(renderedForeground);
                const bg = luminance(background);
                return {
                  text: `${input.getAttribute('placeholder')} placeholder`,
                  foreground: style.color,
                  background: `rgba(${background.slice(0, 3).join(', ')}, ${background[3]})`,
                  contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05),
                  minimum: 4.5,
                };
              }),
            ...measure('.auth-form zwei-icon'),
            ...measure('.auth-switch'),
            ...measure('.auth-switch a'),
            ...measure('.auth-form .submit-button'),
            ...measure('.auth-form mat-error'),
          ],
          surfaces: {
            page: page ? getComputedStyle(page).backgroundImage : '',
            card: card ? getComputedStyle(card).backgroundColor : '',
            field: field ? getComputedStyle(field.querySelector<HTMLElement>('.mat-mdc-text-field-wrapper') ?? field).backgroundColor : '',
            submit: submit ? getComputedStyle(submit).backgroundColor : '',
            submitText: submit ? getComputedStyle(submit).color : '',
          },
          geometry: {
            pageWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            card: card?.getBoundingClientRect().toJSON(),
            submit: submit?.getBoundingClientRect().toJSON(),
            viewport: {width: window.innerWidth, height: window.innerHeight},
          },
        };
      });
      expect(metrics.text.length, `${theme} ${viewport.width}px should have measured visible login text`).toBeGreaterThanOrEqual(7);
      for (const item of metrics.text) expect(item.contrast, `${theme} ${viewport.width}px login contrast ${JSON.stringify(item)}`).toBeGreaterThanOrEqual(item.minimum);
      expect(metrics.geometry.pageWidth, JSON.stringify(metrics.geometry)).toBeLessThanOrEqual(metrics.geometry.clientWidth + 1);
      expect(metrics.geometry.card?.x).toBeGreaterThanOrEqual(0);
      expect((metrics.geometry.card?.x ?? 0) + (metrics.geometry.card?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);
      expect(metrics.geometry.submit?.y).toBeGreaterThanOrEqual(0);
      expect((metrics.geometry.submit?.y ?? 0) + (metrics.geometry.submit?.height ?? 0)).toBeLessThanOrEqual(viewport.height + 1);
      const fieldLabelPlaceholderOverlap = await page.locator('.auth-form mat-form-field').evaluateAll(fields => fields.map(fieldElement => {
        const label = fieldElement.querySelector<HTMLElement>('.mdc-floating-label');
        const control = fieldElement.querySelector<HTMLInputElement>('input');
        if (!label || !control) throw new Error('Login field label/control missing');
        const labelRect = label.getBoundingClientRect();
        const controlRect = control.getBoundingClientRect();
        return {label: labelRect.toJSON(), control: controlRect.toJSON(), placeholderOpacity: getComputedStyle(control, '::placeholder').opacity};
      }));
      for (const fieldState of fieldLabelPlaceholderOverlap) {
        expect(fieldState.placeholderOpacity).toBe('0');
        expect(fieldState.label.left + fieldState.label.width).toBeLessThanOrEqual(fieldState.control.right + 1);
        expect(fieldState.label.right).toBeLessThanOrEqual(fieldState.control.right + 1);
      }
      if (theme === 'dark') {
        expect(metrics.text.find(item => item.text === 'Sign in to zwei')?.foreground).toBe('rgb(241, 245, 249)');
        expect(metrics.surfaces.page).toContain('0.07');
        expect(metrics.surfaces.card).toBe('rgb(32, 44, 59)');
      } else {
        expect(metrics.text.find(item => item.text === 'Sign in to zwei')?.foreground).toBe('rgb(23, 28, 43)');
        expect(metrics.surfaces.page).toContain('248, 223, 193');
        expect(metrics.surfaces.card).toBe('rgba(255, 255, 255, 0.78)');
      }
      await page.screenshot({path: testInfo.outputPath(`login-${theme}-${viewport.width}-${viewport.height}.png`), fullPage: false});
      await input(page, 'email').fill('reader@example.test');
      await input(page, 'password').fill('ExamplePass123!');
      const populatedFieldContrast = await page.locator('.auth-form input').evaluateAll(inputs => inputs.map(inputElement => {
        const foreground = getComputedStyle(inputElement).color;
        const parse = (value: string): [number, number, number, number] => {
          const parts = value.match(/[\d.]+/g)?.map(Number);
          if (!parts || parts.length < 3) throw new Error(`Unexpected rendered color: ${value}`);
          return [parts[0], parts[1], parts[2], parts[3] ?? 1];
        };
        const composite = (front: [number, number, number, number], back: [number, number, number, number]): [number, number, number, number] => {
          const alpha = front[3] + back[3] * (1 - front[3]);
          return [0, 1, 2].map(index => alpha === 0 ? 0 : (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha).concat(alpha) as [number, number, number, number];
        };
        const luminance = (value: [number, number, number, number]) => value.slice(0, 3).map(channel => channel / 255)
          .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
          .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        const page = document.querySelector<HTMLElement>('.auth-page');
        if (!page) throw new Error('Login page surface was not rendered');
        let background = parse(getComputedStyle(document.body).backgroundColor);
        background = composite(parse(getComputedStyle(page).backgroundColor), background);
        const gradientColors = getComputedStyle(page).backgroundImage.match(/rgba?\([\d., ]+\)/g)?.map(parse) ?? [];
        if (gradientColors.length > 0) background = composite(gradientColors[0], background);
        const ancestors: HTMLElement[] = [];
        for (let parent: HTMLElement | null = inputElement.parentElement; parent && parent !== page; parent = parent.parentElement) ancestors.push(parent);
        for (const ancestor of ancestors.reverse()) {
          const layer = parse(getComputedStyle(ancestor).backgroundColor);
          if (layer[3] > 0) background = composite(layer, background);
        }
        const renderedForeground = composite(parse(foreground), background);
        const foregroundLuminance = luminance(renderedForeground);
        const backgroundLuminance = luminance(background);
        return {
          foreground,
          background: `rgba(${background.slice(0, 3).join(', ')}, ${background[3]})`,
          contrast: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05),
        };
      }));
      expect(populatedFieldContrast).toHaveLength(2);
      for (const fieldContrast of populatedFieldContrast) expect(fieldContrast.contrast, `${theme} ${viewport.width}px populated input contrast ${JSON.stringify(fieldContrast)}`).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({path: testInfo.outputPath(`login-${theme}-${viewport.width}-populated.png`), fullPage: false});
      await input(page, 'email').clear();
      await input(page, 'password').clear();
      await input(page, 'email').focus();
      await input(page, 'email').blur();
      await input(page, 'password').focus();
      await input(page, 'password').blur();
      await expect(field(page, 'email').getByText('Email is required.')).toBeVisible();
      await expect(field(page, 'password').getByText('Password is required.')).toBeVisible();
      const errorContrast = await page.locator('mat-error').evaluateAll(errors => errors.map(error => {
        const parse = (value: string): [number, number, number, number] => {
          const values = value.match(/[\d.]+/g)?.map(Number);
          if (!values || values.length < 3) throw new Error(`Unexpected color: ${value}`);
          return [values[0], values[1], values[2], values[3] ?? 1];
        };
        const composite = (front: [number, number, number, number], back: [number, number, number, number]): [number, number, number, number] => {
          const alpha = front[3] + back[3] * (1 - front[3]);
          return [0, 1, 2].map(index => alpha === 0 ? 0 : (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha).concat(alpha) as [number, number, number, number];
        };
        const luminance = (value: [number, number, number, number]) => value.slice(0, 3).map(channel => channel / 255)
          .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
          .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        const parseCompositeBackground = (node: HTMLElement): [number, number, number, number] => {
          const page = document.querySelector<HTMLElement>('.auth-page');
          if (!page) throw new Error('Login page background is missing');
          let rendered = parse(getComputedStyle(document.body).backgroundColor);
          rendered = composite(parse(getComputedStyle(page).backgroundColor), rendered);
          const gradientColors = getComputedStyle(page).backgroundImage.match(/rgba?\([\d., ]+\)/g)?.map(parse) ?? [];
          if (gradientColors.length > 0) rendered = composite(gradientColors[0], rendered);
          const layers: HTMLElement[] = [];
          for (let parent: HTMLElement | null = node; parent && parent !== page; parent = parent.parentElement) layers.push(parent);
          for (const layer of layers.reverse()) rendered = composite(parse(getComputedStyle(layer).backgroundColor), rendered);
          return rendered;
        };
        const foreground = parse(getComputedStyle(error).color);
        const background = parseCompositeBackground(error as HTMLElement);
        const renderedForeground = composite(foreground, background);
        const foregroundLuminance = luminance(renderedForeground);
        const backgroundLuminance = luminance(background);
        return {text: error.textContent?.trim(), contrast: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05)};
      }));
      expect(errorContrast).toHaveLength(2);
      for (const error of errorContrast) expect(error.contrast, `${theme} ${viewport.width}px validation contrast ${JSON.stringify(error)}`).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({path: testInfo.outputPath(`login-${theme}-${viewport.width}-validation.png`), fullPage: false});
      await context.close();
    }
  }
});

test('registration fields preserve readable empty, filled, failure, and keyboard-focus states', async ({browser}, testInfo) => {
  const viewports = [
    {width: 2560, height: 1440},
    {width: 1440, height: 900},
    {width: 1024, height: 768},
    {width: 390, height: 844},
  ];
  for (const viewport of viewports) {
    for (const theme of ['light', 'dark'] as const) {
      const context = await browser.newContext({viewport});
      const page = await context.newPage();
      await page.addInitScript(selectedTheme => localStorage.setItem('zwei_theme', selectedTheme), theme);
      await page.goto('/sign-up');
      await expect(page.getByRole('heading', {name: 'Create your account'})).toBeVisible();
      await expect(page.locator('html')).toHaveClass(new RegExp(`${theme}-theme`));
      const fields = page.locator('.auth-form input');
      await expect(fields).toHaveCount(6);
      const placeholderAttributes = await fields.evaluateAll(inputs => inputs.map(input => ({
        name: input.getAttribute('formcontrolname'),
        placeholder: input.getAttribute('placeholder'),
      })));
      for (const field of placeholderAttributes) {
        expect(field.placeholder, `${theme}/${viewport.width} ${field.name} must use its visible label as the prompt`).toBeNull();
      }
      const inspectFields = async () => page.locator('.auth-form input').evaluateAll(inputs => {
        const rgb = (value: string): [number, number, number, number] => {
          const channels = value.match(/[\d.]+/g)?.map(Number);
          if (!channels || channels.length < 3) throw new Error(`Unexpected color: ${value}`);
          return [channels[0], channels[1], channels[2], channels[3] ?? 1];
        };
        const composite = (top: [number, number, number, number], bottom: [number, number, number, number]): [number, number, number, number] => {
          const alpha = top[3] + bottom[3] * (1 - top[3]);
          return [0, 1, 2].map(index => alpha ? (top[index] * top[3] + bottom[index] * bottom[3] * (1 - top[3])) / alpha : 0).concat(alpha) as [number, number, number, number];
        };
        const luminance = (color: [number, number, number, number]) => color.slice(0, 3).map(value => value / 255)
          .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
          .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const compositedBackground = (node: HTMLElement): [number, number, number, number] => {
          const page = document.querySelector<HTMLElement>('.auth-page');
          if (!page) throw new Error('Registration page background is missing');
          let rendered = rgb(getComputedStyle(document.body).backgroundColor);
          rendered = composite(rgb(getComputedStyle(page).backgroundColor), rendered);
          const gradientColors = getComputedStyle(page).backgroundImage.match(/rgba?\([\d., ]+\)/g)?.map(rgb) ?? [];
          if (gradientColors.length > 0) rendered = composite(gradientColors[0], rendered);
          const layers: HTMLElement[] = [];
          for (let parent: HTMLElement | null = node; parent && parent !== page; parent = parent.parentElement) layers.push(parent);
          for (const layer of layers.reverse()) rendered = composite(rgb(getComputedStyle(layer).backgroundColor), rendered);
          return rendered;
        };
        return inputs.map(input => {
          const wrapper = input.closest('.mat-mdc-text-field-wrapper');
          if (!wrapper) throw new Error('Registration field surface is missing');
          const background = compositedBackground(input as HTMLElement);
          const foreground = rgb(getComputedStyle(input).color);
          const rendered = composite(foreground, background);
          const fg = luminance(rendered);
          const bg = luminance(background);
          const label = input.closest('mat-form-field')?.querySelector<HTMLElement>('.mdc-floating-label');
          if (!label || label.getBoundingClientRect().height === 0) throw new Error(`Visible label is missing for ${input.getAttribute('formcontrolname')}`);
          const labelColor = rgb(getComputedStyle(label).color);
          const labelRendered = composite(labelColor, background);
          const labelFg = luminance(labelRendered);
          return {
            name: input.getAttribute('formcontrolname'),
            valueContrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05),
            labelContrast: (Math.max(labelFg, bg) + .05) / (Math.min(labelFg, bg) + .05),
          };
        });
      });
      const emptyMetrics = await inspectFields();
      expect(emptyMetrics).toHaveLength(6);
      expect(emptyMetrics.map(metric => metric.name).every(Boolean)).toBeTruthy();
      for (const metric of emptyMetrics) expect(metric.labelContrast, `${theme}/${viewport.width} empty registration label ${JSON.stringify(metric)}`).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({path: testInfo.outputPath(`registration-${theme}-${viewport.width}-empty.png`), fullPage: false});

      const values: Record<string, string> = {email: 'reader@example.test', firstName: 'First', lastName: 'Last', nickName: 'Reader', password: 'ExamplePass123!', confirmPassword: 'ExamplePass123!'};
      for (const [name, value] of Object.entries(values)) await page.locator(`[formControlName="${name}"]`).fill(value);
      const filledMetrics = await inspectFields();
      expect(filledMetrics).toHaveLength(6);
      for (const metric of filledMetrics) expect(metric.valueContrast, `${theme}/${viewport.width} filled registration value ${JSON.stringify(metric)}`).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({path: testInfo.outputPath(`registration-${theme}-${viewport.width}-filled.png`), fullPage: false});

      await page.locator('[formControlName="confirmPassword"]').fill('Different123!');
      await page.locator('[formControlName="confirmPassword"]').blur();
      await expect(page.getByText('Passwords do not match.')).toBeVisible();
      await expect(page.locator('.form-error')).toHaveCSS('color', theme === 'dark' ? 'rgb(255, 180, 171)' : 'rgb(186, 26, 26)');
      const validationMetrics = await page.locator('.form-error:visible, mat-error:visible').evaluateAll(messages => {
        type RGBA = [number, number, number, number];
        const parse = (value: string): RGBA => {
          const channels = value.match(/[\d.]+/g)?.map(Number);
          if (!channels || channels.length < 3) throw new Error(`Unexpected color: ${value}`);
          return [channels[0], channels[1], channels[2], channels[3] ?? 1];
        };
        const composite = (top: RGBA, bottom: RGBA): RGBA => {
          const alpha = top[3] + bottom[3] * (1 - top[3]);
          return [0, 1, 2].map(index => alpha ? (top[index] * top[3] + bottom[index] * bottom[3] * (1 - top[3])) / alpha : 0).concat(alpha) as RGBA;
        };
        const luminance = (color: RGBA) => color.slice(0, 3).map(channel => channel / 255)
          .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
          .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
        const backgroundFor = (node: HTMLElement): RGBA => {
          const page = document.querySelector<HTMLElement>('.auth-page');
          if (!page) throw new Error('Registration page background is missing');
          let background = parse(getComputedStyle(document.body).backgroundColor);
          background = composite(parse(getComputedStyle(page).backgroundColor), background);
          const gradientColors = getComputedStyle(page).backgroundImage.match(/rgba?\([\d., ]+\)/g)?.map(parse) ?? [];
          if (gradientColors.length > 0) background = composite(gradientColors[0], background);
          const layers: HTMLElement[] = [];
          for (let parent: HTMLElement | null = node; parent && parent !== page; parent = parent.parentElement) layers.push(parent);
          for (const layer of layers.reverse()) background = composite(parse(getComputedStyle(layer).backgroundColor), background);
          return background;
        };
        return messages.map(message => {
          const background = backgroundFor(message as HTMLElement);
          const foreground = composite(parse(getComputedStyle(message).color), background);
          const foregroundLuminance = luminance(foreground);
          const backgroundLuminance = luminance(background);
          return {
            text: message.textContent?.trim(),
            contrast: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05),
          };
        });
      });
      expect(validationMetrics.length, `${theme}/${viewport.width} visible validation messages`).toBeGreaterThan(0);
      for (const metric of validationMetrics) expect(metric.contrast, `${theme}/${viewport.width} validation contrast ${JSON.stringify(metric)}`).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({path: testInfo.outputPath(`registration-${theme}-${viewport.width}-failure.png`), fullPage: false});

      const first = page.locator('[formControlName="firstName"]');
      await first.focus();
      await expect(first.locator('xpath=ancestor::mat-form-field')).toHaveClass(/mat-focused/);
      const focus = await first.evaluate(element => {
        const outline = getComputedStyle(element).outline;
        const wrapper = element.closest('.mat-mdc-text-field-wrapper');
        return {outline, focused: wrapper?.classList.contains('mdc-text-field--focused'), rect: element.getBoundingClientRect().toJSON()};
      });
      expect(focus.focused).toBeTruthy();
      expect(focus.rect.left).toBeGreaterThanOrEqual(0);
      expect(focus.rect.right).toBeLessThanOrEqual(viewport.width + 1);
      await page.screenshot({path: testInfo.outputPath(`registration-${theme}-${viewport.width}-focus.png`), fullPage: false});
      await context.close();
    }
  }
});

test('keeps registration keyboard-accessible on a reduced-motion mobile viewport', async ({browser}) => {
  const context = await browser.newContext({
    viewport: {width: 390, height: 844},
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto('/sign-up');

  const email = input(page, 'email');
  const firstName = input(page, 'firstName');
  const lastName = input(page, 'lastName');
  await email.focus();
  await email.press('Tab');
  await expect(firstName).toBeFocused();
  await expect(firstName.locator('xpath=ancestor::mat-form-field')).toHaveClass(/mat-focused/);
  const firstBox = await firstName.boundingBox();
  const lastBox = await lastName.boundingBox();
  expect(lastBox?.y).toBeGreaterThan(firstBox?.y || 0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--zwei-motion-duration').trim())).toBe('0ms');

  await context.close();
});

test('registers, rejects duplicate and invalid login, then exposes profile and sign out', async ({page, browser}, testInfo) => {
  const email = uniqueEmail('account');
  await register(page, email, 'Account User');

  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/sign-up');
  await input(page, 'email').fill(email);
  await input(page, 'firstName').fill('Test');
  await input(page, 'lastName').fill('User');
  await input(page, 'nickName').fill('Account User');
  await input(page, 'password').fill(password);
  await input(page, 'confirmPassword').fill(password);
  await page.getByRole('button', {name: 'Create account'}).click();
  await expect(page.getByText('An account with this email already exists. Try signing in instead.')).toBeVisible();

  await login(page, email, 'WrongPassword1!');
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await login(page, email);
  await expect(page).toHaveURL(/\/home$/);
  await restoreSession(page, () => page.reload(), 'home');
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('button', {name: 'Account menu'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Choose a conversation'})).toBeVisible();
  await expect(page.getByPlaceholder('Name or email')).toBeVisible();
  await expect(page.getByLabel('Message composer disabled until a conversation is selected')).toBeVisible();
  await page.evaluate(() => {
    const target = window as Window & {__installPromptCalls?: number};
    target.__installPromptCalls = 0;
    const event = new Event('beforeinstallprompt') as Event & {prompt: () => Promise<void>; userChoice: Promise<{outcome: 'dismissed'}>};
    Object.assign(event, {prompt: () => { target.__installPromptCalls = (target.__installPromptCalls || 0) + 1; return Promise.resolve(); }, userChoice: Promise.resolve({outcome: 'dismissed'})});
    window.dispatchEvent(event);
  });

  await page.getByRole('button', {name: 'Account menu'}).click();
  await expect(page.getByRole('menuitem', {name: 'Profile'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Refresh app'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Install Zwei'})).toBeVisible();
  await page.getByRole('menuitem', {name: 'Install Zwei'}).click();
  await expect.poll(() => page.evaluate(() => (window as Window & {__installPromptCalls?: number}).__installPromptCalls)).toBe(1);
  await page.getByRole('button', {name: 'Account menu'}).click();
  await expect(page.getByRole('menuitem', {name: 'Install Zwei'})).toHaveCount(0);
  await expect(page.getByRole('menuitem', {name: 'Sign out'})).toBeVisible();
  await assertAccountMenuContrast(page, 'dark');
  await page.screenshot({path: testInfo.outputPath('account-menu-dark.png'), fullPage: false});
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const offlineStatus = page.getByText('You’re offline. Zwei will reconnect when your connection returns.');
  await expect(offlineStatus).toBeVisible();
  const offlineGeometry = await offlineStatus.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth};
  });
  expect(offlineGeometry.left).toBeGreaterThanOrEqual(0);
  expect(offlineGeometry.right).toBeLessThanOrEqual(offlineGeometry.viewport + 1);
  await page.screenshot({path: testInfo.outputPath('offline-banner-desktop.png'), fullPage: false});
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(offlineStatus).toHaveCount(0);
  const accountMenuViewports = [
    {width: 2560, height: 1440},
    {width: 1440, height: 900},
    {width: 1024, height: 900},
    {width: 390, height: 844},
  ];
  let accountMenuTheme: 'light' | 'dark' = 'dark';
  for (const viewport of accountMenuViewports) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark'] as const) {
      await page.keyboard.press('Escape');
      await page.getByRole('button', {name: 'Account menu'}).click();
      if (accountMenuTheme !== theme) {
        await page.getByRole('menuitem', {name: `Switch to ${theme} theme`}).click();
        await page.getByRole('button', {name: 'Account menu'}).click();
        accountMenuTheme = theme;
      }
      await expect(page.getByRole('menuitem', {name: 'Profile'})).toBeVisible();
      await expect(page.getByRole('menuitem', {name: 'Sign out'})).toBeVisible();
      await assertAccountMenuContrast(page, theme);
      const geometry = await page.evaluate(() => {
        const menu = document.querySelector<HTMLElement>('.cdk-overlay-container .mat-mdc-menu-panel');
        const trigger = document.querySelector<HTMLElement>('.account-button');
        if (!menu || !trigger) throw new Error('Open account menu panel or trigger is missing');
        const rect = menu.getBoundingClientRect();
        const triggerRect = trigger.getBoundingClientRect();
        const menuBox = {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
        return {menu: menuBox, trigger: {left: triggerRect.left, right: triggerRect.right, top: triggerRect.top, bottom: triggerRect.bottom}, viewport: {width: document.documentElement.clientWidth, height: document.documentElement.clientHeight}, positioning: getComputedStyle(menu).position};
      });
      expect(geometry.menu.left, `${theme} ${viewport.width} account menu left containment`).toBeGreaterThanOrEqual(0);
      expect(geometry.menu.top, `${theme} ${viewport.width} account menu top containment`).toBeGreaterThanOrEqual(0);
      expect(geometry.menu.right, `${theme} ${viewport.width} account menu right containment`).toBeLessThanOrEqual(geometry.viewport.width + 1);
      expect(geometry.menu.bottom, `${theme} ${viewport.width} account menu bottom containment`).toBeLessThanOrEqual(geometry.viewport.height + 1);
      expect(geometry.positioning, `${theme} ${viewport.width} Material account menu positioning`).not.toBe('fixed');
      expect(geometry.menu.left).toBeLessThan(geometry.trigger.right);
      expect(geometry.menu.right).toBeGreaterThan(geometry.trigger.left);
      const triggerGap = Math.min(Math.abs(geometry.menu.bottom - geometry.trigger.top), Math.abs(geometry.menu.top - geometry.trigger.bottom));
      expect(triggerGap, `${theme} ${viewport.width} account menu should remain trigger-anchored: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(24);
      await page.screenshot({path: testInfo.outputPath(`account-menu-${theme}-${viewport.width}x${viewport.height}.png`), fullPage: false});
    }
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', {name: 'Account menu'})).toBeFocused();

  // Keep the same menu open while resizing: Material remains responsible for
  // positioning it relative to its trigger and keeping it within the viewport.
  await page.setViewportSize({width: 390, height: 844});
  for (const theme of ['dark', 'light'] as const) {
    const isLight = await page.locator('html').evaluate(element => element.classList.contains('light-theme'));
    if (isLight !== (theme === 'light')) {
      await page.getByRole('button', {name: 'Account menu'}).click();
      await page.getByRole('menuitem', {name: `Switch to ${theme} theme`}).click();
    }
    await page.getByRole('button', {name: 'Account menu'}).click();
    await expect(page.getByRole('menuitem', {name: 'Profile'})).toBeVisible();
    const mobileMenu = page.locator('.cdk-overlay-container .mat-mdc-menu-panel');
    const mobileAnchoring = await mobileMenu.evaluate(panel => {
      const trigger = document.querySelector<HTMLElement>('.account-button');
      if (!trigger) throw new Error('Account trigger is missing');
      const rect = panel.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      return {position: getComputedStyle(panel).position, menu: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}, trigger: {left: triggerRect.left, right: triggerRect.right, top: triggerRect.top, bottom: triggerRect.bottom}, viewport: {width: innerWidth, height: innerHeight}};
    });
    expect(mobileAnchoring.position, `${theme} mobile menu must use Material positioning`).not.toBe('fixed');
    expect(mobileAnchoring.menu.left).toBeGreaterThanOrEqual(0);
    expect(mobileAnchoring.menu.right).toBeLessThanOrEqual(mobileAnchoring.viewport.width + 1);
    expect(mobileAnchoring.menu.top).toBeGreaterThanOrEqual(0);
    expect(mobileAnchoring.menu.bottom).toBeLessThanOrEqual(mobileAnchoring.viewport.height + 1);
    const mobileTriggerGap = Math.min(Math.abs(mobileAnchoring.menu.bottom - mobileAnchoring.trigger.top), Math.abs(mobileAnchoring.menu.top - mobileAnchoring.trigger.bottom));
    expect(mobileTriggerGap, `${theme} mobile menu trigger geometry: ${JSON.stringify(mobileAnchoring)}`).toBeLessThanOrEqual(24);

    await page.setViewportSize({width: 1440, height: 900});
    await expect.poll(() => mobileMenu.evaluate(panel => getComputedStyle(panel).position)).not.toBe('fixed');
    const desktopAnchoring = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.cdk-overlay-container .mat-mdc-menu-panel');
      const trigger = document.querySelector<HTMLElement>('.account-button');
      if (!panel || !trigger) throw new Error('Open menu or account trigger is missing after resize');
      const menuRect = panel.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      return {menu: {left: menuRect.left, right: menuRect.right, top: menuRect.top, bottom: menuRect.bottom}, trigger: {right: triggerRect.right, bottom: triggerRect.bottom}};
    });
    expect(desktopAnchoring.menu.right, `${theme} desktop menu should remain trigger-anchored: ${JSON.stringify(desktopAnchoring)}`).toBeGreaterThan(desktopAnchoring.trigger.right - 24);
    expect(desktopAnchoring.menu.top, `${theme} desktop menu should open below its trigger: ${JSON.stringify(desktopAnchoring)}`).toBeGreaterThanOrEqual(desktopAnchoring.trigger.bottom - 4);

    await page.setViewportSize({width: 390, height: 844});
    await expect.poll(() => mobileMenu.evaluate(panel => getComputedStyle(panel).position)).not.toBe('fixed');
    const resizedMobile = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.cdk-overlay-container .mat-mdc-menu-panel');
      const trigger = document.querySelector<HTMLElement>('.account-button');
      if (!panel || !trigger) throw new Error('Open menu or trigger disappeared while resizing back to mobile');
      const rect = panel.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      return {menu: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}, trigger: {left: triggerRect.left, right: triggerRect.right, top: triggerRect.top, bottom: triggerRect.bottom}, viewport: {width: innerWidth, height: innerHeight}};
    });
    expect(resizedMobile.menu.left).toBeGreaterThanOrEqual(0);
    expect(resizedMobile.menu.right).toBeLessThanOrEqual(resizedMobile.viewport.width + 1);
    expect(resizedMobile.menu.top).toBeGreaterThanOrEqual(0);
    expect(resizedMobile.menu.bottom).toBeLessThanOrEqual(resizedMobile.viewport.height + 1);
    const resizedTriggerGap = Math.min(Math.abs(resizedMobile.menu.bottom - resizedMobile.trigger.top), Math.abs(resizedMobile.menu.top - resizedMobile.trigger.bottom));
    expect(resizedTriggerGap, `${theme} resized mobile menu trigger geometry: ${JSON.stringify(resizedMobile)}`).toBeLessThanOrEqual(24);
    await assertAccountMenuContrast(page, theme);
    await page.screenshot({path: testInfo.outputPath(`account-menu-resized-mobile-${theme}-390x844.png`), fullPage: false});
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width: 1280, height: 720});
  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: 'Profile'}).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('heading', {name: 'Profile'})).toBeVisible();
  await expect(page.locator('.profile-card').getByText(email)).toBeVisible();
  await expect(page.getByRole('radio', {name: /Notifications and sounds/})).toBeVisible();
  await expect(page.getByRole('radio', {name: /Off/})).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('link', {name: 'Back to chats'})).toBeVisible();
  const soundsOnly = page.getByRole('radio', {name: /Sounds only/});
  await soundsOnly.click();
  await expect(soundsOnly).toHaveAttribute('aria-checked', 'true');
  await restoreSession(page, () => page.reload(), 'profile');
  await expect(page.getByRole('radio', {name: /Sounds only/})).toHaveAttribute('aria-checked', 'true');
  const separateBrowser = await browser.newContext();
  try {
    const otherPage = await separateBrowser.newPage();
    await login(otherPage, email);
    await expect(otherPage).toHaveURL(/\/home$/);
    await restoreSession(otherPage, () => otherPage.goto('/profile'), 'profile');
    await expect(otherPage.getByRole('heading', {name: 'Profile'})).toBeVisible();
    await expect(otherPage.getByRole('radio', {name: /Sounds only/})).toHaveAttribute('aria-checked', 'true');
    expect(await otherPage.evaluate(() => window.localStorage.getItem('zwei_alert_mode'))).toBeNull();
  } finally {
    await separateBrowser.close();
  }
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(value => window.localStorage.setItem('zwei_theme', value), theme);
    await restoreSession(page, () => page.reload(), 'profile');
    await expect(page.getByRole('heading', {name: 'Profile'})).toBeVisible();
    for (const viewport of [
      {width: 2560, height: 1440},
      {width: 1440, height: 900},
      {width: 1024, height: 900},
      {width: 390, height: 844},
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => { const surface = document.querySelector<HTMLElement>('.profile-page'); if (surface) surface.scrollTop = 0; });
      const topGeometry = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('.profile-page');
        const card = document.querySelector<HTMLElement>('.profile-card');
        const firstRadio = document.querySelector<HTMLElement>('.alert-options [role="radio"]');
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          surfaceWidth: surface?.scrollWidth,
          surfaceClientWidth: surface?.clientWidth,
          card: card?.getBoundingClientRect().toJSON(),
          firstRadio: firstRadio?.getBoundingClientRect().toJSON(),
          cardSurface: card ? getComputedStyle(card).backgroundColor : '',
          headingColor: document.querySelector('h1') ? getComputedStyle(document.querySelector('h1') as HTMLElement).color : '',
        };
      });
      expect(topGeometry.documentWidth, `${theme} ${viewport.width}px document overflow`).toBeLessThanOrEqual(topGeometry.viewportWidth);
      expect(topGeometry.surfaceWidth).toBeLessThanOrEqual(topGeometry.surfaceClientWidth);
      expect(topGeometry.card?.left).toBeGreaterThanOrEqual(0);
      expect(topGeometry.card?.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(topGeometry.firstRadio?.top, `${theme} ${viewport.width}px first alert option is visible at the top`).toBeGreaterThanOrEqual(0);
      expect(topGeometry.firstRadio?.bottom, `${theme} ${viewport.width}px first alert option fits in the viewport`).toBeLessThanOrEqual(viewport.height + 1);
      expect(topGeometry.cardSurface).not.toBe('rgba(0, 0, 0, 0)');
      expect(topGeometry.headingColor).not.toBe(topGeometry.cardSurface);
      await page.screenshot({path: testInfo.outputPath(`profile-alert-${theme}-${viewport.width}-top.png`)});
      const endGeometry = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('.profile-page');
        const last = document.querySelectorAll<HTMLElement>('.alert-options [role="radio"]');
        if (surface) surface.scrollTop = surface.scrollHeight;
        return {
          last: last.item(last.length - 1)?.getBoundingClientRect().toJSON(),
        };
      });
      expect(endGeometry.last?.top).toBeGreaterThanOrEqual(0);
      expect(endGeometry.last?.bottom).toBeLessThanOrEqual(viewport.height + 1);
      await page.screenshot({path: testInfo.outputPath(`profile-alert-${theme}-${viewport.width}-end.png`)});
    }
  }
  await page.setViewportSize({width: 1280, height: 720});

  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(page).toHaveURL(/\/login$/);
});
