import {expect, Page, test} from '@playwright/test';

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

async function register(page: Page, email: string, nickname = 'Test User'): Promise<string> {
  const loginResponse = await page.context().request.post(`${adminBase}/api/auth/login`, {
    data: {email: adminEmail, password, device_id: `e2e-admin-${Date.now()}-${Math.random()}`, device_name: 'E2E'},
  });
  const loginPayload = await loginResponse.json() as {access_token: string; token_type: string};
  const invitationResponse = await page.context().request.post(`${adminBase}/api/admin/invitations`, {
    headers: {Authorization: `${loginPayload.token_type} ${loginPayload.access_token}`},
    data: {email},
  });
  const invitationPayload = await invitationResponse.json() as {code: string};
  await page.goto(`/sign-up?invite=1&code=${encodeURIComponent(invitationPayload.code)}`);
  await input(page, 'email').fill(email);
  await input(page, 'firstName').fill('Test');
  await input(page, 'lastName').fill('User');
  await input(page, 'nickName').fill(nickname);
  await input(page, 'password').fill(password);
  await input(page, 'confirmPassword').fill(password);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
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

async function login(page: Page, email: string, value = password): Promise<void> {
  await page.goto('/login');
  await input(page, 'email').fill(email);
  await input(page, 'password').fill(value);
  await page.getByRole('button', {name: 'Sign in'}).click();
}

async function assertAccountMenuContrast(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const metrics = await page.getByRole('menu').evaluate(async menu => {
    const panel = menu.closest<HTMLElement>('.mat-mdc-menu-panel') ?? menu;
    await Promise.all(panel.getAnimations({subtree: true}).map(animation => animation.finished.catch(() => undefined)));
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
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
  expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(response.headers()['content-security-policy']).not.toContain('fonts.googleapis.com');
  expect(response.headers()['content-security-policy']).not.toContain('fonts.gstatic.com');
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

test('registers, rejects duplicate and invalid login, then exposes profile and sign out', async ({page}, testInfo) => {
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
  const refreshResponse = page.waitForResponse(response => response.url().endsWith('/api/auth/refresh') && response.request().method() === 'POST');
  await page.reload();
  expect((await refreshResponse).status()).toBe(200);
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('button', {name: 'Account menu'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Choose a conversation'})).toBeVisible();
  await expect(page.getByPlaceholder('Name or email')).toBeVisible();
  await expect(page.getByLabel('Message composer disabled until a conversation is selected')).toBeVisible();
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt') as Event & {prompt: () => Promise<void>; userChoice: Promise<{outcome: 'dismissed'}>};
    Object.assign(event, {prompt: () => Promise.resolve(), userChoice: Promise.resolve({outcome: 'dismissed'})});
    window.dispatchEvent(event);
  });

  await page.getByRole('button', {name: 'Account menu'}).click();
  await expect(page.getByRole('menuitem', {name: 'Profile'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Install Zwei'})).toBeVisible();
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
  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: 'Switch to light theme'}).click();
  await page.getByRole('button', {name: 'Account menu'}).click();
  await expect(page.getByRole('menuitem', {name: 'Switch to dark theme'})).toBeVisible();
  await assertAccountMenuContrast(page, 'light');
  await page.screenshot({path: testInfo.outputPath('account-menu-light.png'), fullPage: false});
  await page.setViewportSize({width: 390, height: 844});
  const mobileMenuBox = await page.evaluate(() => {
    const menu = Array.from(document.querySelectorAll<HTMLElement>('.mat-mdc-menu-panel')).find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!menu) return undefined;
    const rect = menu.getBoundingClientRect();
    return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
  });
  expect(mobileMenuBox).toBeTruthy();
  expect(mobileMenuBox?.left).toBeGreaterThanOrEqual(0);
  expect(mobileMenuBox?.right).toBeLessThanOrEqual(390);
  await page.screenshot({path: testInfo.outputPath('account-menu-mobile.png'), fullPage: false});
  await page.keyboard.press('Escape');
  await page.setViewportSize({width: 1280, height: 720});
  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: 'Profile'}).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('heading', {name: 'Profile'})).toBeVisible();
  await expect(page.locator('.profile-card').getByText(email)).toBeVisible();
  await expect(page.getByRole('radio', {name: /Notifications and sounds/})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Back to chats'})).toBeVisible();

  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(page).toHaveURL(/\/login$/);
});
