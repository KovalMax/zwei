import {expect, Page, test} from '@playwright/test';
import {fixtureToken} from './session-helpers';

const password = 'Password123!';
const chatBase = process.env.BASE_URL ?? 'https://chat.localhost';
const adminBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';

// GIPHY receives its public quota-bearing key in the search URL. Avoid retaining
// traces, which record request URLs, for this opt-in live-provider check.
test.use({trace: 'off'});

function uniqueEmail(): string {
  return `e2e-giphy-live-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
}

async function registerInvitedUser(page: Page, email: string): Promise<void> {
  const tokens = await fixtureToken(adminBase, adminEmail, password, 'GIPHY live smoke');
  const invitationResponse = await page.context().request.post(`${adminBase}/api/admin/invitations`, {
    headers: {Authorization: `${tokens.token_type} ${tokens.access_token}`},
    data: {email},
  });
  expect(invitationResponse.status()).toBe(201);
  const invitation = await invitationResponse.json() as {code: string};

  await page.goto(`${chatBase}/sign-up?invite=1&code=${encodeURIComponent(invitation.code)}`);
  await page.locator('form').waitFor();
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="firstName"]').fill('Live');
  await page.locator('[formControlName="lastName"]').fill('GIPHY');
  await page.locator('[formControlName="nickName"]').fill('Live GIPHY');
  await page.locator('[formControlName="password"]').fill(password);
  await page.locator('[formControlName="confirmPassword"]').fill(password);
  await page.getByRole('button', {name: 'Create account'}).click();
  await page.waitForURL(/\/home$/);
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string): number => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Expected an RGB color, received ${color}`);
    const linear = channels.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const [first, second] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (first + 0.05) / (second + 0.05);
}

test('searches G-rated results and loads an approved CDN image', async ({browser}, testInfo) => {
  test.skip(process.env.GIPHY_LIVE_E2E !== '1', 'Set GIPHY_LIVE_E2E=1 when a runtime GIPHY key is configured.');
  test.setTimeout(120_000);
  const contextOptions = {viewport: {width: 1440, height: 900}, ignoreHTTPSErrors: true};
  const [senderContext, recipientContext] = await Promise.all([
    browser.newContext(contextOptions),
    browser.newContext(contextOptions),
  ]);
  const senderPage = await senderContext.newPage();
  const recipientPage = await recipientContext.newPage();
  try {
    await registerInvitedUser(senderPage, uniqueEmail());
    await expect.poll(() => senderPage.locator('.chat-presence').textContent(), {timeout: 15_000}).toBe('Live connection');
    const recipientEmail = uniqueEmail();
    await registerInvitedUser(recipientPage, recipientEmail);
    await expect.poll(() => recipientPage.locator('.chat-presence').textContent(), {timeout: 15_000}).toBe('Live connection');
    await senderPage.getByPlaceholder('Name or email').fill(recipientEmail);
    await senderPage.locator('.search-result').filter({hasText: recipientEmail}).click();
    await senderPage.getByRole('button', {name: 'Open GIPHY picker'}).click();

    const picker = senderPage.locator('#giphy-picker');
    const keyGrantResponsePromise = senderPage.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/giphy-key');
    const searchRequestPromise = senderPage.waitForRequest(request => {
      const url = new URL(request.url());
      return url.origin === 'https://api.giphy.com' && url.pathname === '/v1/gifs/search';
    });
    const searchResponsePromise = senderPage.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === 'https://api.giphy.com' && url.pathname === '/v1/gifs/search';
    });
    await picker.getByRole('searchbox', {name: 'Search GIPHY'}).fill('cats');
    await picker.getByRole('button', {name: 'Search', exact: true}).click();

    const keyGrantResponse = await keyGrantResponsePromise;
    expect(keyGrantResponse.status()).toBe(200);
    const [searchRequest, searchResponse] = await Promise.all([searchRequestPromise, searchResponsePromise]);
    const searchURL = new URL(searchRequest.url());
    const headers = await searchRequest.allHeaders();
    expect(searchResponse.status()).toBe(200);
    expect(searchURL.searchParams.get('q')).toBe('cats');
    expect(searchURL.searchParams.get('rating')).toBe('g');
    expect(searchURL.searchParams.get('limit')).toBe('50');
    expect({
      authorization: headers.authorization !== undefined,
      cookie: headers.cookie !== undefined,
      referrer: headers.referer !== undefined,
    }).toEqual({authorization: false, cookie: false, referrer: false});

    const results = picker.locator('.giphy-results button');
    await expect(results.first()).toBeVisible();
    const resultImage = results.first().locator('img');
    await expect.poll(() => resultImage.evaluate(image => (image as HTMLImageElement).naturalWidth), {timeout: 30_000}).toBeGreaterThan(0);
    await senderPage.screenshot({path: testInfo.outputPath('giphy-live-provider-results.png')});

    await results.first().click();
    const previewImage = picker.locator('.giphy-preview img');
    await expect(previewImage).toBeVisible();
    await expect.poll(() => previewImage.evaluate(image => (image as HTMLImageElement).naturalWidth), {timeout: 30_000}).toBeGreaterThan(0);

    const viewports = [
      {width: 2560, height: 1440},
      {width: 1440, height: 900},
      {width: 1024, height: 768},
      {width: 390, height: 844},
    ];
    for (const theme of ['dark', 'light'] as const) {
      const isDark = await senderPage.evaluate(() => document.documentElement.classList.contains('dark-theme'));
      if (isDark !== (theme === 'dark')) {
        await senderPage.getByRole('button', {name: 'Account menu'}).click();
        await senderPage.getByRole('menuitem', {name: `Switch to ${theme} theme`}).click();
        await expect.poll(() => senderPage.evaluate(() => document.documentElement.classList.contains('dark-theme'))).toBe(theme === 'dark');
      }
      for (const viewport of viewports) {
        await senderPage.setViewportSize(viewport);
        const originalLink = picker.locator('.giphy-preview > a');
        const rendered = await originalLink.evaluate(anchor => {
          const panel = anchor.closest('.giphy-picker');
          if (!panel) throw new Error('Original-media link is not contained by the GIPHY picker');
          const rect = (element: Element) => {
            const bounds = element.getBoundingClientRect();
            return {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom};
          };
          return {
            foreground: getComputedStyle(anchor).color,
            background: getComputedStyle(panel).backgroundColor,
            link: rect(anchor),
            panel: rect(panel),
            viewport: {width: innerWidth, height: innerHeight},
            scrollWidth: panel.scrollWidth,
            clientWidth: panel.clientWidth,
          };
        });
        const ratio = contrastRatio(rendered.foreground, rendered.background);
        const context = `${theme} ${viewport.width}x${viewport.height}; contrast=${ratio.toFixed(2)}:1; rendered=${JSON.stringify(rendered)}`;
        expect(await originalLink.evaluate(anchor => getComputedStyle(anchor).textDecorationLine), context).toContain('underline');
        expect(ratio, context).toBeGreaterThanOrEqual(4.5);
        expect(rendered.link.x, context).toBeGreaterThanOrEqual(rendered.panel.x);
        expect(rendered.link.right, context).toBeLessThanOrEqual(rendered.panel.right);
        expect(rendered.link.y, context).toBeGreaterThanOrEqual(0);
        expect(rendered.link.bottom, context).toBeLessThanOrEqual(rendered.viewport.height);
        expect(rendered.panel.y, context).toBeGreaterThanOrEqual(0);
        expect(rendered.panel.bottom, context).toBeLessThanOrEqual(rendered.viewport.height);
        expect(rendered.panel.x, context).toBeGreaterThanOrEqual(0);
        expect(rendered.panel.right, context).toBeLessThanOrEqual(rendered.viewport.width);
        expect(rendered.scrollWidth, context).toBeLessThanOrEqual(rendered.clientWidth + 1);
        await senderPage.screenshot({path: testInfo.outputPath(`giphy-live-preview-${theme}-${viewport.width}x${viewport.height}.png`)});
        if (viewport.width === 390) {
          await originalLink.evaluate(anchor => (anchor as HTMLElement).focus({focusVisible: true}));
          const focusOutline = await originalLink.evaluate(anchor => ({style: getComputedStyle(anchor).outlineStyle, width: getComputedStyle(anchor).outlineWidth}));
          expect(focusOutline.style, context).toBe('solid');
          expect(Number.parseFloat(focusOutline.width), context).toBeGreaterThanOrEqual(2);
          await senderPage.screenshot({path: testInfo.outputPath(`giphy-live-preview-focus-${theme}-390x844.png`)});
        }
      }
    }
  } finally {
    await Promise.all([senderContext.close(), recipientContext.close()]);
  }
});
