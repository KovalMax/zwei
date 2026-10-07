import {expect, test} from '@playwright/test';

// Stable-reference matrix: anonymous empty login plus authenticated Home-empty,
// search-open, and group-create states × {light, dark} × {1440×900, 390×844}.
// Broader viewport and dynamic-state contracts live in the feature flow specs.
// Snapshots are approved separately; normal test runs must only compare them.
const viewports = [{width: 1440, height: 900}, {width: 390, height: 844}] as const;
const themes = ['light', 'dark'] as const;
const visualBaselinePassword = 'Password123!';
const adminBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';

async function registerBaselineUser(page: import('@playwright/test').Page, email: string, nickName: string): Promise<void> {
  const loginResponse = await page.context().request.post(`${adminBase}/api/auth/login`, {
    data: {email: adminEmail, password: visualBaselinePassword, device_id: `visual-baseline-admin-${crypto.randomUUID()}`, device_name: 'E2E'},
  });
  expect(loginResponse.status()).toBe(200);
  const loginPayload = await loginResponse.json() as {access_token: string; token_type: string};
  const invitationResponse = await page.context().request.post(`${adminBase}/api/admin/invitations`, {
    headers: {Authorization: `${loginPayload.token_type} ${loginPayload.access_token}`},
    data: {email},
  });
  expect(invitationResponse.status()).toBe(201);
  const invitation = await invitationResponse.json() as {code: string};

  await page.goto(`/sign-up?invite=1&code=${encodeURIComponent(invitation.code)}`);
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="firstName"]').fill('Visual');
  await page.locator('[formControlName="lastName"]').fill('Baseline');
  await page.locator('[formControlName="nickName"]').fill(nickName);
  await page.locator('[formControlName="password"]').fill(visualBaselinePassword);
  await page.locator('[formControlName="confirmPassword"]').fill(visualBaselinePassword);
  const registration = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create account'}).click();
  const response = await registration;
  expect(response.status()).toBe(201);
  await expect(page).toHaveURL(/\/home$/);
}

async function selectBaselineTheme(page: import('@playwright/test').Page, theme: typeof themes[number]): Promise<void> {
  const isDark = await page.locator('html').evaluate(element => element.classList.contains('dark-theme'));
  if (isDark !== (theme === 'dark')) {
    await page.getByRole('button', {name: 'Account menu'}).click();
    await page.getByRole('menuitem', {name: `Switch to ${theme} theme`}).click();
  }
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}-theme\\b`));
  await expect(page.locator('body')).toHaveClass(new RegExp(`\\b${theme}-theme\\b`));
}

for (const theme of themes) {
  for (const viewport of viewports) {
    test(`anonymous empty login visual baseline: ${theme} ${viewport.width}x${viewport.height}`, async ({browser}, testInfo) => {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        locale: 'en-US',
        timezoneId: 'UTC',
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        await page.addInitScript(selectedTheme => localStorage.setItem('zwei_theme', selectedTheme), theme);
        await page.goto('/login');
        await expect(page).toHaveURL(/\/login$/);
        await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}-theme\\b`));
        await expect(page.locator('body')).toHaveClass(new RegExp(`\\b${theme}-theme\\b`));

        const card = page.locator('.auth-card');
        const form = card.locator('form.auth-form');
        const email = form.locator('input[formControlName="email"]');
        const password = form.locator('input[formControlName="password"]');
        const submit = form.getByRole('button', {name: 'Sign in'});
        await expect(card.getByText('Welcome back')).toBeVisible();
        await expect(card.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
        await expect(card.getByText('Your private conversations are waiting for you.')).toBeVisible();
        await expect(card.getByText("Don't have an account?")).toBeVisible();
        await expect(card.getByRole('link', {name: 'Create one'})).toBeVisible();
        await expect(form).toBeVisible();
        await expect(form.locator('mat-form-field')).toHaveCount(2);
        await expect(form.getByText('Email address')).toBeVisible();
        await expect(form.getByText('Password', {exact: true})).toBeVisible();
        await expect(email).toBeVisible();
        await expect(password).toBeVisible();
        await expect(email).toHaveValue('');
        await expect(password).toHaveValue('');
        await expect(submit).toBeVisible();
        await expect(submit).toBeDisabled();
        await expect(form).toHaveAttribute('aria-busy', 'false');
        await expect(page.locator('.auth-loading')).toHaveCount(0);
        await expect(page.getByRole('button', {name: 'Account menu'})).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        const loadedFonts = await page.evaluate(() => Array.from(document.fonts)
          .filter(face => face.status === 'loaded').map(face => face.family));
        expect(loadedFonts).toContain('DM Sans');

        const metrics = await page.evaluate(() => {
          const element = (selector: string): HTMLElement => {
            const found = document.querySelector<HTMLElement>(selector);
            if (!found) throw new Error(`Missing login element: ${selector}`);
            return found;
          };
          const box = (node: Element) => {
            const {left, top, right, bottom, width, height} = node.getBoundingClientRect();
            return {left, top, right, bottom, width, height};
          };
          const color = (value: string): [number, number, number, number] => {
            const channels = value.match(/[\d.]+/g)?.map(Number);
            if (!channels || channels.length < 3) throw new Error(`Unexpected color: ${value}`);
            return [channels[0], channels[1], channels[2], channels[3] ?? 1];
          };
          const luminance = (rgb: number[]) => rgb.slice(0, 3)
            .map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
            .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
          const pageBackdrop = color(getComputedStyle(element('.auth-page')).backgroundColor);
          const surface = color(getComputedStyle(element('.auth-card')).backgroundColor);
          const foreground = color(getComputedStyle(element('.auth-intro h1')).color);
          const fg = luminance(foreground);
          const gradientColors = getComputedStyle(element('.auth-page')).backgroundImage.match(/rgba?\([\d., ]+\)/g)?.map(color) ?? [];
          const pageBackdrops = [pageBackdrop, ...gradientColors.map(gradient => {
            const alpha = gradient[3] + pageBackdrop[3] * (1 - gradient[3]);
            return [0, 1, 2].map(index => alpha === 0 ? 0 : (gradient[index] * gradient[3] + pageBackdrop[index] * pageBackdrop[3] * (1 - gradient[3])) / alpha).concat(alpha);
          })];
          const titleContrasts = pageBackdrops.map(backdrop => {
            const background = surface.slice(0, 3).map((channel, index) => channel * surface[3] + backdrop[index] * (1 - surface[3]));
            const backgroundLuminance = luminance(background);
            return (Math.max(fg, backgroundLuminance) + .05) / (Math.min(fg, backgroundLuminance) + .05);
          });
          const buttonElement = element('.submit-button');
          const buttonBackground = getComputedStyle(buttonElement).backgroundColor;
          const buttonBackgroundLuminance = luminance(color(buttonBackground));
          const buttonForeground = getComputedStyle(buttonElement).color;
          const buttonForegroundLuminance = luminance(color(buttonForeground));
          const fieldNodes = Array.from(document.querySelectorAll<HTMLElement>('.auth-form mat-form-field'));
          return {
            viewport: {width: innerWidth, height: innerHeight},
            overflow: [document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth],
            page: box(element('.auth-page')),
            card: box(element('.auth-card')),
            form: box(element('.auth-form')),
            button: box(element('.submit-button')),
            fields: fieldNodes.map(field => ({
              field: box(field),
              wrapper: box(field.querySelector('.mat-mdc-text-field-wrapper') ?? field),
              input: box(field.querySelector('input') ?? field),
              border: getComputedStyle(field.querySelector('.mdc-notched-outline__leading') ?? field).borderColor,
              surface: getComputedStyle(field.querySelector('.mat-mdc-text-field-wrapper') ?? field).backgroundColor,
            })),
            cardStyle: {
              background: getComputedStyle(element('.auth-card')).backgroundColor,
              borderStyle: getComputedStyle(element('.auth-card')).borderTopStyle,
              borderWidth: getComputedStyle(element('.auth-card')).borderTopWidth,
              borderColor: getComputedStyle(element('.auth-card')).borderTopColor,
            },
            titleColor: getComputedStyle(element('.auth-intro h1')).color,
            titleContrast: Math.min(...titleContrasts),
            buttonBackground,
            buttonForeground,
            buttonOpacity: getComputedStyle(buttonElement).opacity,
            buttonContrast: (Math.max(buttonBackgroundLuminance, buttonForegroundLuminance) + .05) / (Math.min(buttonBackgroundLuminance, buttonForegroundLuminance) + .05),
          };
        });
        const label = `${theme} ${viewport.width}x${viewport.height}: ${JSON.stringify(metrics)}`;
        expect(metrics.viewport, label).toEqual(viewport);
        for (const overflow of metrics.overflow) expect(overflow, label).toBeLessThanOrEqual(1);
        expect(metrics.page.left, label).toBeGreaterThanOrEqual(0);
        expect(metrics.page.right, label).toBeLessThanOrEqual(viewport.width + 1);
        expect(metrics.card.width, label).toBeGreaterThan(300);
        expect(metrics.card.width, label).toBeLessThanOrEqual(440);
        expect(metrics.card.left, label).toBeGreaterThanOrEqual(0);
        expect(metrics.card.right, label).toBeLessThanOrEqual(viewport.width + 1);
        expect(metrics.card.top, label).toBeGreaterThanOrEqual(64);
        expect(metrics.card.bottom, label).toBeLessThanOrEqual(viewport.height + 1);
        expect(Math.abs((metrics.card.left + metrics.card.right) / 2 - viewport.width / 2), label).toBeLessThanOrEqual(2);
        if (viewport.width > 600) {
          expect(Math.abs((metrics.card.top + metrics.card.bottom) / 2 - (metrics.page.top + metrics.page.bottom) / 2), label).toBeLessThanOrEqual(2);
        } else {
          expect(metrics.card.top, label).toBeGreaterThanOrEqual(metrics.page.top + 24);
        }
        expect(metrics.cardStyle.borderStyle, label).toBe('solid');
        expect(metrics.cardStyle.borderWidth, label).toBe('1px');
        expect(metrics.cardStyle.borderColor, label).toBe(theme === 'dark' ? 'rgb(48, 70, 94)' : 'rgb(207, 217, 232)');
        expect(metrics.cardStyle.background, label).toBe(theme === 'dark' ? 'rgb(32, 44, 59)' : 'rgba(255, 255, 255, 0.78)');
        expect(metrics.titleColor, label).toBe(theme === 'dark' ? 'rgb(241, 245, 249)' : 'rgb(23, 28, 43)');
        expect(metrics.titleContrast, label).toBeGreaterThanOrEqual(4.5);
        expect(metrics.buttonBackground, label).toBe('rgb(102, 112, 133)');
        expect(metrics.buttonForeground, label).toBe('rgb(255, 255, 255)');
        expect(metrics.buttonOpacity, label).toBe('1');
        expect(metrics.buttonContrast, label).toBeGreaterThanOrEqual(4.5);
        expect(metrics.fields, label).toHaveLength(2);
        for (const field of metrics.fields) {
          expect(field.field.width, label).toBeGreaterThan(250);
          expect(Math.abs(field.field.width - metrics.form.width), label).toBeLessThanOrEqual(1);
          expect(field.field.left, label).toBeGreaterThanOrEqual(metrics.card.left + 1);
          expect(field.field.right, label).toBeLessThanOrEqual(metrics.card.right - 1);
          expect(field.wrapper.left, label).toBeGreaterThanOrEqual(field.field.left - 1);
          expect(field.wrapper.right, label).toBeLessThanOrEqual(field.field.right + 1);
          expect(field.input.left, label).toBeGreaterThanOrEqual(field.wrapper.left);
          expect(field.input.right, label).toBeLessThanOrEqual(field.wrapper.right + 1);
          expect(field.border, label).toBe(theme === 'dark' ? 'rgb(131, 151, 173)' : 'rgb(111, 107, 102)');
          expect(field.surface, label).toBe(theme === 'dark' ? 'rgb(32, 44, 59)' : 'rgba(255, 255, 255, 0.72)');
        }
        expect(metrics.fields[0].field.bottom, label).toBeLessThanOrEqual(metrics.fields[1].field.top + 1);
        expect(metrics.button.left, label).toBeGreaterThanOrEqual(metrics.form.left - 1);
        expect(metrics.button.right, label).toBeLessThanOrEqual(metrics.form.right + 1);
        expect(metrics.button.top, label).toBeGreaterThanOrEqual(metrics.fields[1].field.bottom - 1);
        expect(metrics.button.bottom, label).toBeLessThanOrEqual(metrics.card.bottom - 1);

        const name = `login-empty-${theme}-${viewport.width}x${viewport.height}.png`;
        const capture = {animations: 'disabled', caret: 'hide', fullPage: false} as const;
        await page.screenshot({...capture, path: testInfo.outputPath(`diagnostic-${name}`)});
        await expect(page).toHaveScreenshot(name, capture);

        // Keyboard focus remains independently visible; don't include it in the empty-state pixels.
        await page.keyboard.press('Tab');
        await expect(page.getByRole('link', {name: 'zwei home'})).toBeFocused();
        const outline = await page.getByRole('link', {name: 'zwei home'}).evaluate(link => ({
          style: getComputedStyle(link).outlineStyle,
          width: getComputedStyle(link).outlineWidth,
        }));
        expect(outline).toEqual({style: 'solid', width: '3px'});
      } finally {
        await context.close();
      }
    });
  }
}

test('stable authenticated Home, search, and group-create visual baselines', async ({browser}, testInfo) => {
  test.setTimeout(120_000);
  const contextOptions = {
    viewport: viewports[0],
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  } as const;
  const context = await browser.newContext(contextOptions);
  try {
    const page = await context.newPage();
    await registerBaselineUser(page, `visual-baseline-owner-${crypto.randomUUID()}@example.test`, 'Baseline Owner');
    await expect(page.getByRole('heading', {name: 'Your messages, your space'})).toBeVisible();
    const capture = {animations: 'disabled', caret: 'hide', fullPage: false} as const;
    const saveAndCompare = async (state: string, theme: typeof themes[number], viewport: typeof viewports[number]) => {
      const name = `${state}-${theme}-${viewport.width}x${viewport.height}.png`;
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({path: testInfo.outputPath(`diagnostic-${name}`), ...capture});
      await expect(page).toHaveScreenshot(name, capture);
    };

    for (const theme of themes) {
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await selectBaselineTheme(page, theme);
        if (viewport.width <= 760) {
          const rail = page.locator('.conversation-rail');
          await expect(rail.getByText('All chats')).toBeVisible();
          await expect(rail.locator('.people-list')).toBeVisible();
          await expect(rail.locator('.people-list .person-option')).toHaveCount(0);
        } else {
          await expect(page.getByRole('heading', {name: 'Your messages, your space'})).toBeVisible();
        }
        await saveAndCompare('home-empty', theme, viewport);

        const search = page.getByPlaceholder('Name or email');
        await search.fill('E2E Admin');
        const result = page.getByRole('button', {name: 'Start a conversation with E2E Admin'});
        await expect(result).toBeVisible();
        await expect(result.locator('small')).toHaveText('e2e-admin@example.test');
        await saveAndCompare('search-open', theme, viewport);

        await search.clear();
        await page.getByRole('button', {name: 'Create group'}).click();
        const card = page.locator('.group-create-card');
        await expect(card.getByLabel('Group name')).toBeVisible();
        await saveAndCompare('group-create-empty', theme, viewport);

        await card.getByLabel('Group name').fill('   ');
        await card.getByRole('button', {name: 'Create group'}).click();
        await expect(card.getByRole('alert')).toHaveText('Enter a group name.');
        await saveAndCompare('group-create-validation', theme, viewport);

        await card.getByLabel('Group name').fill('Baseline planning');
        await expect(card.getByRole('alert')).toHaveCount(0);
        await saveAndCompare('group-create-filled', theme, viewport);
        await page.getByRole('button', {name: 'Cancel'}).click();
        await expect(card).toHaveCount(0);
      }
    }

  } finally {
    await context.close();
  }
});
