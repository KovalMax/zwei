import {expect, Page, test} from '@playwright/test';
import {fixtureToken} from './session-helpers';

// Authentication and WebSocket traffic must not be retained in traces.
test.use({viewport: {width: 390, height: 844}, hasTouch: true, trace: 'off'});

const authBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';
const password = 'Password123!';

async function swipe(page: Page, y: number, x = 25, endX = 140, endY = y): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y, id: 1}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: endX, y: endY, id: 1}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await cdp.detach();
}

test('mobile edge swipe returns selected chat and profile without replacing back controls', async ({page}, testInfo) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const state = window as Window & {swipeCallTracks?: MediaStreamTrack[]};
    state.swipeCallTracks = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await original(constraints);
      state.swipeCallTracks?.push(...stream.getTracks());
      return stream;
    };
  });
  const email = `e2e-swipe-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  const admin = await fixtureToken(authBase, adminEmail, password, 'E2E');
  const invitation = await page.request.post(`${authBase}/api/admin/invitations`, {headers: {Authorization: `${admin.token_type} ${admin.access_token}`}, data: {email}});
  expect(invitation.status()).toBe(201);
  const {code} = await invitation.json() as {code: string};
  await page.goto(`/sign-up?invite=1&code=${encodeURIComponent(code)}`);
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="firstName"]').fill('Swipe');
  await page.locator('[formControlName="lastName"]').fill('Test');
  await page.locator('[formControlName="nickName"]').fill('Swipe');
  await page.locator('[formControlName="password"]').fill(password);
  await page.locator('[formControlName="confirmPassword"]').fill(password);
  await page.getByRole('button', {name: 'Create account'}).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.getByRole('button', {name: 'Create group'}).click();
  await page.locator('#group-name').fill('Swipe test group');
  await page.getByRole('button', {name: 'Create group', exact: true}).last().click();
  const closeSettings = page.locator('.group-manager').getByRole('button', {name: 'Close group settings'});
  await expect(closeSettings).toBeVisible();
  await closeSettings.click();
  const history = page.locator('.message-history');
  await expect(history).toBeVisible();
  await expect(page.getByRole('button', {name: 'Back to chats'})).toBeVisible();
  const bounds = await history.boundingBox();
  if (!bounds) throw new Error('Missing history bounds');
  const y = Math.round(bounds.y + bounds.height / 2);
  await swipe(page, y, 25, 55, y + 100);
  await expect(history).toBeVisible();
  await page.evaluate(() => {
    const state = window as Window & {swipeTouchObservation?: {events: {count: number; inChat: boolean}[]; listener: EventListener}};
    const events: {count: number; inChat: boolean}[] = [];
    const listener: EventListener = event => {
      const touch = event as TouchEvent;
      events.push({count: touch.touches.length, inChat: event.target instanceof Element && !!event.target.closest('.chat-panel')});
    };
    state.swipeTouchObservation = {events, listener};
    document.addEventListener('touchstart', listener, true);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: 25, y, id: 1}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: 25, y, id: 1}, {x: 200, y: 30, id: 2}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: [{x: 25, y, id: 1}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: 140, y, id: 1}]});
  await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  await cdp.detach();
  const starts = await page.evaluate(() => {
    const state = window as Window & {swipeTouchObservation?: {events: {count: number; inChat: boolean}[]; listener: EventListener}};
    const observation = state.swipeTouchObservation;
    if (!observation) throw new Error('Touch observation missing');
    document.removeEventListener('touchstart', observation.listener, true);
    delete state.swipeTouchObservation;
    return observation.events;
  });
  expect(starts).toContainEqual({count: 1, inChat: true});
  expect(starts).toContainEqual({count: 2, inChat: false});
  await expect(history).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('selected-mobile.png')});
  await swipe(page, y);
  await expect(page.locator('.conversation-rail')).toBeVisible();
  await expect(history).toHaveCount(0);
  await swipe(page, 400);
  await expect(page).toHaveURL(/\/home$/);
  await page.screenshot({path: testInfo.outputPath('list-mobile.png')});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: /profile/i}).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('link', {name: 'Back to chats'})).toBeVisible();
  // Open a real overlay deliberately rather than depending on its navigation lifecycle.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await page.getByRole('button', {name: 'Account menu'}).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await swipe(page, 400);
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('menu')).toBeVisible();
  await page.locator('.cdk-overlay-pane').evaluate(async pane => {
    await Promise.all(pane.getAnimations({subtree: true}).map(animation => animation.finished.catch(() => undefined)));
  });
  await page.screenshot({path: testInfo.outputPath('profile-overlay-mobile.png')});
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await page.screenshot({path: testInfo.outputPath('profile-mobile.png')});
  await swipe(page, 400);
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.locator('.conversation-rail')).toBeVisible();

  if (!(await page.locator('html').evaluate(node => node.classList.contains('light-theme')))) {
    await page.getByRole('button', {name: 'Account menu'}).click();
    await page.getByRole('menuitem', {name: 'Switch to light theme'}).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
  }
  await page.getByRole('button', {name: 'Swipe test group', exact: true}).click();
  await expect(history).toBeVisible();
  await page.screenshot({path: testInfo.outputPath('selected-light-mobile.png')});
  const mobileGeometry = await page.locator('.chat-panel').evaluate(panel => {
    const rect = panel.getBoundingClientRect();
    const back = panel.querySelector('.back-button')?.getBoundingClientRect();
    return {left: rect.left, right: rect.right, backLeft: back?.left, backRight: back?.right, documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth};
  });
  expect(mobileGeometry.left).toBeGreaterThanOrEqual(0);
  expect(mobileGeometry.right).toBeLessThanOrEqual(390);
  expect(mobileGeometry.backLeft).toBeGreaterThanOrEqual(0);
  expect(mobileGeometry.backRight).toBeLessThanOrEqual(390);
  expect(mobileGeometry.documentWidth).toBeLessThanOrEqual(mobileGeometry.viewportWidth);
  await swipe(page, y);
  await expect(history).toHaveCount(0);

  for (const width of [1024, 1440, 2560]) {
    await page.setViewportSize({width, height: 900});
    await page.getByRole('button', {name: 'Swipe test group', exact: true}).click();
    await expect(history).toBeVisible();
    await swipe(page, 400);
    await expect(history).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }

  // A real group call keeps its existing UI and media ownership; touch navigation
  // is unavailable both on the focused surface and while the call is minimized.
  await page.setViewportSize({width: 390, height: 844});
  const startCall = page.getByRole('button', {name: 'Join or start group audio call'});
  await expect(startCall).toBeEnabled({timeout: 10_000});
  await startCall.click();
  const callSurface = page.locator('.group-call-panel');
  await expect(callSurface).toContainText('1 participant in the group call.', {timeout: 10_000});
  const callBounds = await callSurface.boundingBox();
  if (!callBounds) throw new Error('Missing group call bounds');
  await swipe(page, Math.round(callBounds.y + callBounds.height / 2));
  await expect(callSurface).toBeVisible();
  await expect(page.getByRole('button', {name: 'Back to chats'})).toBeVisible();
  const tracks = () => page.evaluate(() => (window as Window & {swipeCallTracks?: MediaStreamTrack[]}).swipeCallTracks?.map(track => track.readyState) ?? []);
  await expect.poll(tracks).toContain('live');
  await page.screenshot({path: testInfo.outputPath('group-call-focused-mobile.png')});
  await page.getByRole('button', {name: 'Minimize group call'}).click();
  await expect(history).toBeVisible();
  const minimizedHistory = await history.boundingBox();
  if (!minimizedHistory) throw new Error('Missing minimized call chat bounds');
  const minimizedY = Math.round(minimizedHistory.y + minimizedHistory.height / 2);
  expect(await page.evaluate(position => {
    const target = document.elementFromPoint(25, position);
    return !!target?.closest('.chat-panel') && !target.closest('button, a, input, textarea, select');
  }, minimizedY)).toBe(true);
  await swipe(page, minimizedY);
  await expect(history).toBeVisible();
  await expect.poll(tracks).toContain('live');
  await page.screenshot({path: testInfo.outputPath('group-call-minimized-blocked-mobile.png')});
  await page.getByRole('button', {name: 'Back to chats'}).click();
  await expect(page.locator('.conversation-rail')).toBeVisible();
  await expect.poll(tracks).toContain('live');
  await page.getByRole('button', {name: 'Swipe test group', exact: true}).click();
  await page.locator('.chat-panel app-minimized-call-banner').getByRole('button', {name: 'End group call for everyone'}).click();
  await expect.poll(tracks).not.toContain('live');
});

test('KYC profile edge swipe returns to admin', async ({browser}, testInfo) => {
  const context = await browser.newContext({
    viewport: {width: 390, height: 844}, hasTouch: true, ignoreHTTPSErrors: true,
    httpCredentials: {username: process.env.KYC_BASIC_AUTH_USER ?? 'kyc-admin', password: process.env.KYC_BASIC_AUTH_PASSWORD ?? 'local-basic-auth-change-me'},
  });
  try {
    const page = await context.newPage();
    await page.goto(`${authBase}/login`);
    await page.locator('[formControlName="email"]').fill(adminEmail);
    await page.locator('[formControlName="password"]').fill(process.env.E2E_ADMIN_PASSWORD ?? password);
    await page.getByRole('button', {name: 'Sign in'}).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole('button', {name: 'Account menu'}).click();
    await page.getByRole('menuitem', {name: 'Profile'}).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole('link', {name: 'Back to KYC admin'})).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await page.screenshot({path: testInfo.outputPath('kyc-profile-mobile.png')});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await swipe(page, 400);
    await expect(page).toHaveURL(/\/admin$/);
    const table = page.getByRole('region', {name: 'Account list; scroll horizontally for details'});
    await table.scrollIntoViewIfNeeded();
    await expect(table.locator('tbody tr').first()).toBeVisible();
    for (const position of ['top', 'end'] as const) {
      await table.evaluate((element, where) => { element.scrollTop = where === 'top' ? 0 : element.scrollHeight; }, position);
      const geometry = await table.evaluate((element, where) => {
        const bounds = element.getBoundingClientRect();
        const rows = element.querySelectorAll('tbody tr');
        const row = rows[where === 'top' ? 0 : rows.length - 1]?.getBoundingClientRect();
        const header = element.querySelector('thead th')?.getBoundingClientRect();
        return {top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, rowTop: row?.top, rowBottom: row?.bottom, headerTop: header?.top, headerBottom: header?.bottom, viewportWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight};
      }, position);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      expect(geometry.top).toBeGreaterThanOrEqual(0);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
      expect(geometry.rowTop).toBeGreaterThanOrEqual((geometry.headerBottom ?? geometry.top) - 1);
      expect(geometry.rowBottom).toBeLessThanOrEqual(geometry.bottom + 1);
      expect(geometry.headerTop).toBeGreaterThanOrEqual(geometry.top - 1);
      if (position === 'end') expect(geometry.scrollTop).toBeGreaterThanOrEqual(Math.max(0, geometry.scrollHeight - geometry.clientHeight) - 1);
      await page.screenshot({path: testInfo.outputPath(`kyc-admin-${position}-mobile.png`)});
    }
  } finally { await context.close(); }
});
