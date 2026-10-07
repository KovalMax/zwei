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
    const target = window as Window & {__installPromptCalls?: number};
    target.__installPromptCalls = 0;
    const event = new Event('beforeinstallprompt') as Event & {prompt: () => Promise<void>; userChoice: Promise<{outcome: 'dismissed'}>};
    Object.assign(event, {prompt: () => { target.__installPromptCalls = (target.__installPromptCalls || 0) + 1; return Promise.resolve(); }, userChoice: Promise.resolve({outcome: 'dismissed'})});
    window.dispatchEvent(event);
  });

  await page.getByRole('button', {name: 'Account menu'}).click();
  await expect(page.getByRole('menuitem', {name: 'Profile'})).toBeVisible();
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
        if (!menu) throw new Error('Open account menu panel is missing');
        const rect = menu.getBoundingClientRect();
        const box = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) throw new Error(`Expected chat control ${selector} is missing`);
          const bounds = element.getBoundingClientRect();
          return {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom};
        };
        const menuBox = {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
        const overlaps = (other: typeof menuBox) => menuBox.left < other.right && menuBox.right > other.left && menuBox.top < other.bottom && menuBox.bottom > other.top;
        return {
          menu: menuBox,
          viewport: {width: document.documentElement.clientWidth, height: document.documentElement.clientHeight},
          controls: {
            peopleSearch: box('.search-field'),
            newGroup: box('.new-group-button'),
            countArea: box('.rail-label'),
          },
          overlap: {
            peopleSearch: overlaps(box('.search-field')),
            newGroup: overlaps(box('.new-group-button')),
            countArea: overlaps(box('.rail-label')),
          },
        };
      });
      expect(geometry.menu.left, `${theme} ${viewport.width} account menu left containment`).toBeGreaterThanOrEqual(0);
      expect(geometry.menu.top, `${theme} ${viewport.width} account menu top containment`).toBeGreaterThanOrEqual(0);
      expect(geometry.menu.right, `${theme} ${viewport.width} account menu right containment`).toBeLessThanOrEqual(geometry.viewport.width + 1);
      expect(geometry.menu.bottom, `${theme} ${viewport.width} account menu bottom containment`).toBeLessThanOrEqual(geometry.viewport.height + 1);
      expect(geometry.overlap, `${theme} ${viewport.width} account-menu/control overlap: ${JSON.stringify(geometry)}`).toEqual({peopleSearch: false, newGroup: false, countArea: false});
      await page.screenshot({path: testInfo.outputPath(`account-menu-${theme}-${viewport.width}x${viewport.height}.png`), fullPage: false});
    }
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', {name: 'Account menu'})).toBeFocused();

  // Keep the same menu open as the viewport crosses the custom mobile breakpoint.
  // It must switch back to Material's trigger anchoring on desktop and regain the
  // mobile bottom/right inset when resized back, without covering rail controls.
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
      const style = getComputedStyle(panel);
      const rect = panel.getBoundingClientRect();
      return {position: style.position, right: innerWidth - rect.right, bottom: innerHeight - rect.bottom};
    });
    expect(mobileAnchoring.position, `${theme} mobile menu position`).toBe('fixed');
    expect(mobileAnchoring.right, `${theme} mobile right inset`).toBeCloseTo(16, 0);
    expect(mobileAnchoring.bottom, `${theme} mobile bottom inset`).toBeCloseTo(16, 0);

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
    await expect.poll(() => mobileMenu.evaluate(panel => getComputedStyle(panel).position)).toBe('fixed');
    const resizedMobile = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.cdk-overlay-container .mat-mdc-menu-panel');
      if (!panel) throw new Error('Open menu disappeared while resizing back to mobile');
      const rect = panel.getBoundingClientRect();
      const box = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Expected chat control ${selector} is missing`);
        return element.getBoundingClientRect();
      };
      const overlap = (bounds: DOMRect) => rect.left < bounds.right && rect.right > bounds.left && rect.top < bounds.bottom && rect.bottom > bounds.top;
      return {right: innerWidth - rect.right, bottom: innerHeight - rect.bottom, peopleSearch: overlap(box('.search-field')), newGroup: overlap(box('.new-group-button')), countArea: overlap(box('.rail-label'))};
    });
    expect(resizedMobile.right, `${theme} resized mobile right inset`).toBeCloseTo(16, 0);
    expect(resizedMobile.bottom, `${theme} resized mobile bottom inset`).toBeCloseTo(16, 0);
    expect({peopleSearch: resizedMobile.peopleSearch, newGroup: resizedMobile.newGroup, countArea: resizedMobile.countArea}, `${theme} resized mobile menu overlaps rail controls`).toEqual({peopleSearch: false, newGroup: false, countArea: false});
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
  await expect(page.getByRole('link', {name: 'Back to chats'})).toBeVisible();

  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(page).toHaveURL(/\/login$/);
});
