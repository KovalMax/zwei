import {expect, Page, APIRequestContext, TestInfo, test} from '@playwright/test';
import {fixtureToken, restoreSession} from './session-helpers';

const password = process.env.E2E_ADMIN_PASSWORD ?? 'Password123!';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';
const adminBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const basicAuthUser = process.env.KYC_BASIC_AUTH_USER ?? 'kyc-admin';
const basicAuthPassword = process.env.KYC_BASIC_AUTH_PASSWORD ?? 'local-basic-auth-change-me';

function uniqueEmail(name: string): string {
  return `e2e-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
}

async function expectNoVisibleNotchSeam(page: Page, selector: string, context: string): Promise<void> {
  const seams = await page.locator(`${selector} .mdc-notched-outline__notch`).evaluateAll(elements => elements.map(element => {
    const color = getComputedStyle(element).borderLeftColor;
    return {color, alpha: color.match(/[\d.]+/g)?.map(Number)?.[3] ?? 1};
  }));
  expect(seams.length, `${context}: expected notched outline segments`).toBeGreaterThan(0);
  for (const seam of seams) expect(seam.alpha, `${context}: ${JSON.stringify(seam)}`).toBe(0);
}

async function fillRegistration(page: Page, email: string): Promise<void> {
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="firstName"]').fill('Kyc');
  await page.locator('[formControlName="lastName"]').fill('Test');
  await page.locator('[formControlName="nickName"]').fill('Kyc Test');
  if (await page.locator('[formControlName="password"]').count()) {
    await page.locator('[formControlName="password"]').fill(password);
    await page.locator('[formControlName="confirmPassword"]').fill(password);
  }
}

async function register(page: Page, email: string, invitationCode?: string): Promise<{status: number; accessToken?: string}> {
  const suffix = invitationCode ? `?invite=1&code=${encodeURIComponent(invitationCode)}` : '';
  await page.goto(`/sign-up${suffix}`);
  await fillRegistration(page, email);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/v2/register') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create account'}).click();
  const response = await responsePromise;
  if (invitationCode) expect(response.request().postDataJSON()).toHaveProperty('password', password);
  else expect(response.request().postDataJSON()).not.toHaveProperty('password');
  const payload = await response.json() as {access_token?: string};
  return {status: response.status(), accessToken: payload.access_token};
}

async function registerFromInvitationLink(page: Page, email: string, link: string): Promise<{status: number; accessToken?: string}> {
  await page.goto(link);
  await expect(page.locator('[formControlName="password"]')).toBeVisible();
  await fillRegistration(page, email);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/v2/register') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create account'}).click();
  const response = await responsePromise;
  expect(response.request().postDataJSON()).toHaveProperty('password', password);
  const payload = await response.json() as {access_token?: string};
  return {status: response.status(), accessToken: payload.access_token};
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${process.env.BASE_URL ?? 'https://chat.localhost'}/login`);
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="password"]').fill(password);
  await page.getByRole('button', {name: 'Sign in'}).click();
}

async function adminLogin(page: Page): Promise<void> {
  await page.goto(`${adminBase}/login`);
  await page.locator('[formControlName="email"]').fill(adminEmail);
  await page.locator('[formControlName="password"]').fill(password);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test('admin media source settings use enabled contract and deny anonymous reads', async ({browser, request}, testInfo) => {
  const anonymous = await request.get(`${adminBase}/api/admin/media-sources/giphy`);
  expect(anonymous.status()).toBe(401);
  const anonymousUpdate = await request.put(`${adminBase}/api/admin/media-sources/giphy`, {data: {enabled: false}});
  expect(anonymousUpdate.status()).toBe(401);
  const context = await browser.newContext({viewport: {width: 390, height: 844}, httpCredentials: {username: basicAuthUser, password: basicAuthPassword}});
  const page = await context.newPage();
  let initialEnabled: boolean | undefined;
  try {
    await adminLogin(page);
    await page.getByRole('button', {name: 'Media sources'}).click();
    const checkbox = page.getByRole('checkbox', {name: 'Enable reviewed GIPHY source'});
    await expect(checkbox).toBeVisible();
    const initial = await checkbox.isChecked();
    initialEnabled = initial;
    const write = page.waitForResponse(response => response.url().endsWith('/api/admin/media-sources/giphy') && response.request().method() === 'PUT');
    await checkbox.setChecked(!initial);
    const response = await write;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({enabled: !initial});
    expect(await response.json()).toEqual({enabled: !initial});
    await expect(checkbox).toBeChecked({checked: !initial});
    const geometry = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('.media-source-toggle input');
      const rect = input?.getBoundingClientRect();
      return {documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
        left: rect?.left ?? -1, right: rect?.right ?? Number.MAX_SAFE_INTEGER, height: rect?.height ?? 0};
    });
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.height).toBeGreaterThan(0);
    await page.screenshot({path: testInfo.outputPath('admin-media-sources-mobile.png')});
    await page.evaluate(() => {
      document.documentElement.classList.add('dark-theme');
      document.body.classList.add('dark-theme');
    });
    const darkSurface = await page.locator('.admin-card').evaluate(element => ({
      background: getComputedStyle(element).backgroundColor,
      text: getComputedStyle(element.querySelector('h2') as HTMLElement).color,
      width: element.getBoundingClientRect().width,
    }));
    expect(darkSurface.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(darkSurface.text).not.toBe('');
    expect(darkSurface.width).toBeLessThanOrEqual(390);
    await expect(checkbox).toBeVisible();
    await page.screenshot({path: testInfo.outputPath('admin-media-sources-dark-mobile.png')});
  } finally {
    if (initialEnabled !== undefined) {
      const token = await fixtureToken(adminBase, adminEmail, password, 'restore-giphy');
      const restored = await context.request.put(`${adminBase}/api/admin/media-sources/giphy`, {headers: {Authorization: `${token.token_type} ${token.access_token}`}, data: {enabled: initialEnabled}});
      expect(restored.ok()).toBeTruthy();
    }
    await context.close();
  }
});

async function reloadAdmin(page: Page): Promise<void> {
  await restoreSession(page, () => page.reload(), 'admin');
}

async function activationLinks(request: APIRequestContext, email: string, minimum = 1): Promise<string[]> {
  let links: string[] = [];
  await expect.poll(async () => {
    const response = await request.get('http://mailpit:8025/api/v1/messages?limit=50');
    if (!response.ok()) return 0;
    const payload = await response.json() as {messages?: Array<{ID: string; To?: Array<{Address?: string}>}>};
    const messages = payload.messages?.filter(item => item.To?.some(recipient => recipient.Address === email)) ?? [];
    const details = await Promise.all(messages.map(item => request.get(`http://mailpit:8025/api/v1/message/${item.ID}`)));
    links = [];
    for (const detail of details) {
      if (!detail.ok()) continue;
      const text = JSON.stringify(await detail.json()).replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/%23/gi, '#');
      const link = text.match(/https:\/\/chat\.localhost\/activate#setup=[A-Za-z0-9_-]{43}/)?.[0];
      if (link && !links.includes(link)) links.push(link);
    }
    return links.length;
  }, {timeout: 10_000}).toBeGreaterThanOrEqual(minimum);
  return links;
}

async function setupLink(request: APIRequestContext, email: string): Promise<string> {
  const link = (await activationLinks(request, email))[0];
  if (typeof link !== 'string' || !link.startsWith('https://chat.localhost/activate#setup=')) {
    throw new Error('Mailpit did not return a valid password setup URL');
  }
  return link;
}

async function setPassword(page: Page): Promise<void> {
  await page.locator('[formControlName="password"]').fill(password);
  await page.locator('[formControlName="confirmPassword"]').fill(password);
}

async function invitationLink(request: APIRequestContext, email: string): Promise<string> {
  let link = '';
  await expect.poll(async () => {
    const response = await request.get('http://mailpit:8025/api/v1/messages?limit=50');
    if (!response.ok()) return '';
    const payload = await response.json() as {messages?: Array<{ID: string; To?: Array<{Address?: string}>}>};
    const message = payload.messages?.find(item => item.To?.some(recipient => recipient.Address === email));
    if (!message) return '';
    const detail = await request.get(`http://mailpit:8025/api/v1/message/${message.ID}`);
    if (!detail.ok()) return '';
    const text = JSON.stringify(await detail.json());
    link = text.match(/https:\/\/chat\.localhost\/sign-up\?invite=1&code=[A-Za-z0-9_-]+/)?.[0] ?? '';
    return link;
  }, {timeout: 10_000}).toBeTruthy();
  return link;
}

async function captureTableBounds(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const table = page.locator('.table-wrap').first();
  const rows = table.locator('tbody tr');
  const adminScroller = page.locator('.admin-page');
  const initialAdminScrollTop = await adminScroller.evaluate(element => element.scrollTop);
  const initialTableScrollTop = await table.evaluate(element => element.scrollTop);
  await adminScroller.evaluate(element => { element.scrollTop = 0; });
  await table.evaluate(element => { element.scrollTop = 0; });
  await expect(rows.first()).toBeVisible();
  const firstRowGeometry = await rows.first().evaluate(row => {
    const rect = row.getBoundingClientRect();
    return {top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight};
  });
  expect(firstRowGeometry.top, `${name} first row must be fully inside the top-state viewport`).toBeGreaterThanOrEqual(0);
  expect(firstRowGeometry.bottom, `${name} first row must be fully inside the top-state viewport`).toBeLessThanOrEqual(firstRowGeometry.viewportHeight);
  await page.screenshot({path: testInfo.outputPath(`${name}-top.png`), fullPage: false});

  const end = await table.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return {scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight};
  });
  expect(end.scrollTop).toBeGreaterThanOrEqual(Math.max(0, end.scrollHeight - end.clientHeight) - 1);
  await expect(rows.last()).toBeVisible();
  // The table is internally scrollable, but the admin page can also scroll.
  // Move the outer page only as much as needed to show the end row while
  // keeping the table's sticky header visible in the same viewport.
  await adminScroller.evaluate(scroller => {
    const row = scroller.querySelector('.table-wrap tbody tr:last-child');
    if (!row) throw new Error('KYC account table must contain a final row');
    const scrollerRect = scroller.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const visibleTop = Math.max(0, scrollerRect.top);
    const visibleBottom = Math.min(window.innerHeight, scrollerRect.bottom);
    const delta = rowRect.bottom > visibleBottom
      ? Math.ceil(rowRect.bottom - visibleBottom)
      : rowRect.top < visibleTop ? Math.floor(rowRect.top - visibleTop) : 0;
    scroller.scrollTop += delta;
  });
  const lastRowGeometry = await rows.last().evaluate(row => {
    const rect = row.getBoundingClientRect();
    const table = row.closest<HTMLElement>('.table-wrap');
    if (!table) throw new Error('KYC account table row must belong to a table scrollport');
    const tableRect = table.getBoundingClientRect();
    const header = table.querySelector('thead th');
    if (!header) throw new Error('KYC account table must contain a header');
    const headerRect = header.getBoundingClientRect();
    const borderTop = Number.parseFloat(getComputedStyle(table).borderTopWidth);
    return {
      top: rect.top,
      bottom: rect.bottom,
      viewportHeight: window.innerHeight,
      tableTop: tableRect.top,
      tableBottom: tableRect.bottom,
      tableBorderTop: borderTop,
      tableLeft: tableRect.left,
      tableRight: tableRect.right,
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      tableScrollTop: table.scrollTop,
      tableScrollHeight: table.scrollHeight,
      tableClientHeight: table.clientHeight,
      tableScrollWidth: table.scrollWidth,
      tableClientWidth: table.clientWidth,
      adminScrollTop: document.querySelector<HTMLElement>('.admin-page')?.scrollTop,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
    };
  });
  console.log(`KYC table end geometry (${name}): ${JSON.stringify(lastRowGeometry)}`);
  expect(lastRowGeometry.top, `${name} final row must be fully inside viewport`).toBeGreaterThanOrEqual(0);
  expect(lastRowGeometry.bottom, `${name} final row must be fully inside viewport`).toBeLessThanOrEqual(lastRowGeometry.viewportHeight);
  expect(lastRowGeometry.headerTop, `${name} table header must remain in viewport`).toBeGreaterThanOrEqual(0);
  expect(lastRowGeometry.headerBottom, `${name} table header must remain in viewport`).toBeLessThanOrEqual(lastRowGeometry.viewportHeight);
  expect(lastRowGeometry.headerTop, `${name} sticky header must remain pinned to the table scrollport`).toBeGreaterThanOrEqual(lastRowGeometry.tableTop + lastRowGeometry.tableBorderTop - 1);
  expect(lastRowGeometry.headerTop, `${name} sticky header must remain pinned to the table scrollport`).toBeLessThanOrEqual(lastRowGeometry.tableTop + lastRowGeometry.tableBorderTop + 1);
  expect(lastRowGeometry.tableLeft, `${name} table must remain horizontally contained`).toBeGreaterThanOrEqual(0);
  expect(lastRowGeometry.tableRight, `${name} table must remain horizontally contained`).toBeLessThanOrEqual(lastRowGeometry.documentClientWidth);
  expect(lastRowGeometry.tableScrollWidth, `${name} table scrollport must expose its horizontal content`).toBeGreaterThanOrEqual(lastRowGeometry.tableClientWidth);
  await page.screenshot({path: testInfo.outputPath(`${name}-end.png`), fullPage: false});
  await adminScroller.evaluate((element, scrollTop) => { element.scrollTop = scrollTop; }, initialAdminScrollTop);
  await table.evaluate((element, scrollTop) => { element.scrollTop = scrollTop; }, initialTableScrollTop);
}

async function assertPinnedTableSurfacesAreOpaque(page: Page): Promise<void> {
  const surfaces = await page.locator('.table-wrap').evaluate(tableElement => {
    const table = tableElement as HTMLElement;
    table.scrollLeft = table.scrollWidth;
    const allSurfaces = Array.from(table.querySelectorAll<HTMLElement>('thead th, tbody td:first-child, tbody td:last-child'));
    const pinnedSurfaces = new Set(table.querySelectorAll<HTMLElement>('thead th:first-child, thead th:last-child, tbody td:first-child, tbody td:last-child'));
    return allSurfaces.map(surface => {
      const background = getComputedStyle(surface).backgroundColor;
      const channels = background.match(/[\d.]+/g) ?? [];
      const alpha = background.startsWith('rgba') ? Number(channels[3]) : 1;
      const rect = surface.getBoundingClientRect();
      const tableRect = table.getBoundingClientRect();
      return {alpha, pinned: pinnedSurfaces.has(surface), left: rect.left, right: rect.right, tableLeft: tableRect.left, tableRight: tableRect.right};
    });
  });
  expect(surfaces.length).toBeGreaterThan(0);
  for (const surface of surfaces) {
    expect(surface.alpha).toBe(1);
    if (surface.pinned) {
      expect(surface.left).toBeGreaterThanOrEqual(surface.tableLeft - 1);
      expect(surface.right).toBeLessThanOrEqual(surface.tableRight + 1);
    }
  }
}

async function assertInvitationFieldContrastAndContainment(page: Page): Promise<void> {
  const rendered = await page.locator('.invitation-form').evaluate(formElement => {
    const form = formElement as HTMLElement;
    const field = form.querySelector<HTMLElement>('mat-form-field');
    const input = form.querySelector<HTMLInputElement>('input');
    const label = form.querySelector<HTMLElement>('.mdc-floating-label');
    const button = form.querySelector<HTMLElement>('button');
    if (!field || !input || !label || !button) return null;

    const composite = (foreground: string, background: string): string => {
      const foregroundChannels = foreground.match(/[\d.]+/g) ?? [];
      const backgroundChannels = background.match(/[\d.]+/g) ?? [];
      const alpha = foreground.startsWith('rgba') ? Number(foregroundChannels[3]) : 1;
      const backgroundAlpha = background.startsWith('rgba') ? Number(backgroundChannels[3]) : 1;
      const outputAlpha = alpha + backgroundAlpha * (1 - alpha);
      const channels = [0, 1, 2].map(index => {
        const foregroundChannel = Number(foregroundChannels[index]);
        const backgroundChannel = Number(backgroundChannels[index]);
        return Math.round((foregroundChannel * alpha + backgroundChannel * backgroundAlpha * (1 - alpha)) / outputAlpha);
      });
      return `rgb(${channels.join(', ')})`;
    };
    const compositedBackground = (element: HTMLElement): string => {
      const ancestors: HTMLElement[] = [];
      let current: HTMLElement | null = element;
      while (current) {
        ancestors.push(current);
        current = current.parentElement;
      }
      let background = 'rgb(255, 255, 255)';
      for (const ancestor of ancestors.reverse()) {
        const color = getComputedStyle(ancestor).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)') background = composite(color, background);
      }
      return background;
    };
    const luminance = (color: string): number => {
      const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(channel => Number(channel) / 255).map(channel =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (foreground: string, background: string): number => {
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
    };
    const surface = compositedBackground(field);
    const inputStyle = getComputedStyle(input);
    const labelStyle = getComputedStyle(label);
    const rect = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      return {left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom};
    };
    const fieldRect = rect(field);
    const buttonRect = rect(button);
    return {
      theme: document.documentElement.className,
      inputColor: inputStyle.color,
      labelColor: labelStyle.color,
      surface,
      inputContrast: contrast(inputStyle.color, surface),
      labelContrast: contrast(labelStyle.color, surface),
      field: fieldRect,
      button: buttonRect,
      viewport: {width: document.documentElement.clientWidth, height: document.documentElement.clientHeight},
      activeElement: document.activeElement === input,
      focused: input.matches(':focus'),
    };
  });
  if (!rendered) throw new Error('invitation field and submit button were not rendered');
  console.log('KYC invitation field appearance', JSON.stringify(rendered));
  expect(rendered.inputContrast, `entered email contrast: ${JSON.stringify(rendered)}`).toBeGreaterThanOrEqual(4.5);
  expect(rendered.labelContrast, `floating label contrast: ${JSON.stringify(rendered)}`).toBeGreaterThanOrEqual(4.5);
  expect(rendered.field.left).toBeGreaterThanOrEqual(0);
  expect(rendered.field.right).toBeLessThanOrEqual(rendered.viewport.width + 1);
  expect(rendered.field.top).toBeGreaterThanOrEqual(0);
  expect(rendered.field.bottom).toBeLessThanOrEqual(rendered.viewport.height + 1);
  expect(rendered.button.left).toBeGreaterThanOrEqual(0);
  expect(rendered.button.right).toBeLessThanOrEqual(rendered.viewport.width + 1);
  expect(rendered.button.top).toBeGreaterThanOrEqual(0);
  expect(rendered.button.bottom).toBeLessThanOrEqual(rendered.viewport.height + 1);
  const controlsOverlap = rendered.field.left < rendered.button.right && rendered.field.right > rendered.button.left && rendered.field.top < rendered.button.bottom && rendered.field.bottom > rendered.button.top;
  expect(controlsOverlap).toBeFalsy();
}

async function switchAdminTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const currentClass = theme === 'dark' ? 'dark-theme' : 'light-theme';
  if (await page.locator('html').evaluate((element, className) => element.classList.contains(className), currentClass)) return;
  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: `Switch to ${theme} theme`}).click();
  await expect(page.locator('html')).toHaveClass(new RegExp(currentClass));
  await page.keyboard.press('Escape');
  await expect.poll(() => page.locator('.invitation-form .mdc-floating-label').evaluate(label => getComputedStyle(label).color))
    .toBe(theme === 'dark' ? 'rgb(192, 204, 218)' : 'rgb(117, 108, 98)');
}

test('pending registration, admin approval, activation email, and blocked login', async ({browser, request}, testInfo) => {
  // This flow includes the full admin theme/viewport matrix and email activation.
  test.setTimeout(90_000);
  expect((await request.get(`${adminBase}/`)).status()).toBe(401);
  const pendingEmail = uniqueEmail('pending');
  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  await user.goto('/sign-up');
  for (const theme of ['dark', 'light'] as const) {
    for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
      // Each matrix cell starts with a new ordinary signup form so a previous focus
      // or validation interaction cannot leak into its pristine-state capture.
      await user.goto('/sign-up');
      await user.evaluate(selectedTheme => {
        document.documentElement.classList.toggle('dark-theme', selectedTheme === 'dark');
        document.body.classList.toggle('dark-theme', selectedTheme === 'dark');
        document.documentElement.classList.toggle('light-theme', selectedTheme === 'light');
        document.body.classList.toggle('light-theme', selectedTheme === 'light');
      }, theme);
      await expect(user.locator('html')).toHaveClass(new RegExp(`${theme}-theme`));
      await user.setViewportSize(viewport);
      await expect(user.locator('[formControlName="password"]')).toHaveCount(0);
      const signupFields = user.locator('.auth-form input[formControlName]');
      await expect(signupFields).toHaveCount(4);
      for (const field of await signupFields.all()) {
        await expect(field).toHaveValue('');
        await expect(field).toHaveClass(/ng-untouched/);
        await expect(field).toHaveClass(/ng-pristine/);
      }
      await expect(user.locator('.auth-form mat-error:visible')).toHaveCount(0);
      await expect(user.locator('.auth-form [role="alert"]')).toHaveCount(0);
      const signupGeometry = await user.evaluate(() => {
        const form = document.querySelector<HTMLElement>('.auth-form');
        const card = document.querySelector<HTMLElement>('.auth-card');
        const rect = form?.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();
        const controls = Array.from(form?.querySelectorAll<HTMLElement>('input, button') ?? []).map(control => {
          const bounds = control.getBoundingClientRect();
          return {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom};
        });
        return {documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
          left: rect?.left ?? -1, right: rect?.right ?? Number.MAX_SAFE_INTEGER,
          cardLeft: cardRect?.left ?? -1, cardRight: cardRect?.right ?? Number.MAX_SAFE_INTEGER,
          controlContainment: controls.map(control => ({insideForm: !!rect && control.left >= rect.left - 1 && control.right <= rect.right + 1,
            insideViewport: control.left >= 0 && control.right <= document.documentElement.clientWidth + 1,
            top: control.top, bottom: control.bottom}))};
      });
      expect(signupGeometry.documentWidth).toBeLessThanOrEqual(signupGeometry.viewportWidth + 1);
      expect(signupGeometry.left).toBeGreaterThanOrEqual(0);
      expect(signupGeometry.right).toBeLessThanOrEqual(signupGeometry.viewportWidth + 1);
      expect(signupGeometry.cardLeft).toBeGreaterThanOrEqual(0);
      expect(signupGeometry.cardRight).toBeLessThanOrEqual(signupGeometry.viewportWidth + 1);
      expect(signupGeometry.controlContainment.length).toBeGreaterThan(0);
      for (const control of signupGeometry.controlContainment) {
        expect(control.insideForm).toBeTruthy();
        expect(control.insideViewport).toBeTruthy();
      }
      const focusedSignupField = user.locator('[formControlName="email"]');
      await expect(focusedSignupField).not.toBeFocused();
      await expect(user.locator('.auth-form :focus')).toHaveCount(0);
      await user.screenshot({path: testInfo.outputPath(`kyc-signup-${theme}-${viewport.width}-empty.png`), fullPage: false});
      await focusedSignupField.focus();
      await expect(focusedSignupField).toBeFocused();
      await expect(focusedSignupField.locator('xpath=ancestor::mat-form-field')).toHaveClass(/mat-focused/);
      const focusedSignupOutline = await focusedSignupField.evaluate(input => {
        const field = input.closest('mat-form-field');
        const outline = field?.querySelector<HTMLElement>('.mdc-notched-outline');
        const style = outline && getComputedStyle(outline);
        const rect = outline?.getBoundingClientRect();
        return {focused: field?.classList.contains('mat-focused'), visible: !!rect && rect.width > 0 && rect.height > 0 && style?.visibility === 'visible', borderColor: style?.borderColor};
      });
      expect(focusedSignupOutline.focused).toBeTruthy();
      expect(focusedSignupOutline.visible).toBeTruthy();
      expect(focusedSignupOutline.borderColor).not.toBe('rgba(0, 0, 0, 0)');
      await user.screenshot({path: testInfo.outputPath(`kyc-signup-${theme}-${viewport.width}-focus.png`), fullPage: false});
      await focusedSignupField.blur();
      await expect(focusedSignupField).not.toBeFocused();
    }
  }
  await fillRegistration(user, pendingEmail);
  const registrationResponsePromise = user.waitForResponse(response => response.url().endsWith('/api/auth/v2/register') && response.request().method() === 'POST');
  await user.getByRole('button', {name: 'Create account'}).click();
  const registrationResponse = await registrationResponsePromise;
  expect(registrationResponse.status()).toBe(202);
  expect(registrationResponse.request().postDataJSON()).not.toHaveProperty('password');
  const registration = {status: registrationResponse.status(), accessToken: (await registrationResponse.json() as {access_token?: string}).access_token};
  expect(registration.accessToken).toBeUndefined();
  await expect(user).toHaveURL(/\/pending$/);
  await expect(user.locator('.auth-card')).toBeVisible();
  await expect(user.locator('[formControlName="password"]')).toHaveCount(0);
  await expect(user.getByText(/password setup link/i)).toBeVisible();
  await user.setViewportSize({width: 1440, height: 900});
  const pendingCardWidth = await user.locator('.auth-card').evaluate(element => element.getBoundingClientRect().width);
  expect(pendingCardWidth).toBeLessThanOrEqual(440);
  await user.screenshot({path: testInfo.outputPath('kyc-pending-dark.png'), fullPage: false});
  await user.setViewportSize({width: 390, height: 844});
  expect(await user.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
  await user.screenshot({path: testInfo.outputPath('kyc-pending-dark-mobile.png'), fullPage: false});
  await user.evaluate(() => localStorage.setItem('zwei_theme', 'light'));
  await user.reload();
  await expect(user.locator('html')).toHaveClass(/light-theme/);
  await user.setViewportSize({width: 1440, height: 900});
  await user.screenshot({path: testInfo.outputPath('kyc-pending-light.png'), fullPage: false});
  await user.setViewportSize({width: 390, height: 844});
  expect(await user.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
  await user.screenshot({path: testInfo.outputPath('kyc-pending-light-mobile.png'), fullPage: false});
  const initialSetupLink = await setupLink(request, pendingEmail);
  expect(new URL(initialSetupLink).search).toBe('');
  expect(new URL(initialSetupLink).hash).toMatch(/^#setup=[A-Za-z0-9_-]{43}$/);
  await user.goto(initialSetupLink);
  await expect(user.getByRole('heading', {name: 'Set your password'})).toBeVisible();
  await expect(user.getByRole('button', {name: 'Set password'})).toBeDisabled();
  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') {
      await user.evaluate(() => { document.documentElement.classList.remove('light-theme'); document.body.classList.remove('light-theme'); document.documentElement.classList.add('dark-theme'); document.body.classList.add('dark-theme'); });
    }
    for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
      await user.setViewportSize(viewport);
      const setupFields = user.locator('.auth-form input[formControlName]');
      await expect(setupFields).toHaveCount(2);
      for (const field of await setupFields.all()) {
        await expect(field).toHaveValue('');
        await expect(field).toHaveClass(/ng-untouched/);
        await expect(field).toHaveClass(/ng-pristine/);
      }
      await expect(user.locator('.auth-form :focus')).toHaveCount(0);
      await expect(user.locator('.auth-form mat-error:visible')).toHaveCount(0);
      const setupGeometry = await user.evaluate(() => {
        const form = document.querySelector<HTMLElement>('.auth-form');
        const button = form?.querySelector<HTMLElement>('button');
        const rect = form?.getBoundingClientRect();
        const buttonRect = button?.getBoundingClientRect();
        const controls = Array.from(form?.querySelectorAll<HTMLElement>('input, button') ?? []).map(control => {
          const bounds = control.getBoundingClientRect();
          return {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom};
        });
        const notchSeams = Array.from(form?.querySelectorAll<HTMLElement>('.mdc-notched-outline__notch') ?? []).map(notch => {
          const color = getComputedStyle(notch).borderLeftColor;
          return {color, alpha: color.match(/[\d.]+/g)?.map(Number)?.[3] ?? 1};
        });
        const outlineGeometry = Array.from(form?.querySelectorAll<HTMLElement>('mat-form-field') ?? []).map(field => {
          const rect = (element: Element | null) => {
            const bounds = element?.getBoundingClientRect();
            return bounds && {left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height};
          };
          const outline = field.querySelector<HTMLElement>('.mdc-notched-outline');
          const leading = field.querySelector<HTMLElement>('.mdc-notched-outline__leading');
          const notch = field.querySelector<HTMLElement>('.mdc-notched-outline__notch');
          const trailing = field.querySelector<HTMLElement>('.mdc-notched-outline__trailing');
          const label = field.querySelector<HTMLElement>('.mdc-floating-label');
          const segment = (element: HTMLElement | null) => element && {
            rect: rect(element),
            borderTopWidth: getComputedStyle(element).borderTopWidth,
            borderTopColor: getComputedStyle(element).borderTopColor,
            borderLeftWidth: getComputedStyle(element).borderLeftWidth,
            borderLeftColor: getComputedStyle(element).borderLeftColor,
          };
          return {outline: rect(outline), leading: segment(leading), notch: segment(notch), trailing: segment(trailing),
            label: rect(label),
            input: rect(field.querySelector('input')), field: rect(field)};
        });
        return {documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
          documentClientWidth: document.documentElement.clientWidth,
          formLeft: rect?.left ?? -1, formRight: rect?.right ?? Number.MAX_SAFE_INTEGER,
          buttonLeft: buttonRect?.left ?? -1, buttonRight: buttonRect?.right ?? Number.MAX_SAFE_INTEGER,
          controls: controls.map(control => ({insideForm: !!rect && control.left >= rect.left - 1 && control.right <= rect.right + 1 && control.top >= rect.top - 1 && control.bottom <= rect.bottom + 1,
            insideViewport: control.left >= 0 && control.right <= document.documentElement.clientWidth + 1 && control.top >= 0 && control.bottom <= document.documentElement.clientHeight + 1})),
          notchSeams, outlineGeometry,
          controlsOverlap: controls.some((control, index) => controls.slice(index + 1).some(other => control.left < other.right && control.right > other.left && control.top < other.bottom && control.bottom > other.top))};
      });
      console.log(`KYC empty password setup outline (${theme}/${viewport.width}px): ${JSON.stringify(setupGeometry.outlineGeometry)}`);
      expect(setupGeometry.documentWidth).toBeLessThanOrEqual(setupGeometry.viewportWidth + 1);
      expect(setupGeometry.formLeft).toBeGreaterThanOrEqual(0);
      expect(setupGeometry.formRight).toBeLessThanOrEqual(setupGeometry.viewportWidth + 1);
      expect(setupGeometry.buttonLeft).toBeGreaterThanOrEqual(0);
      expect(setupGeometry.buttonRight).toBeLessThanOrEqual(setupGeometry.viewportWidth + 1);
      expect(setupGeometry.controls.length).toBeGreaterThan(0);
      expect(setupGeometry.notchSeams.length).toBeGreaterThan(0);
      for (const seam of setupGeometry.notchSeams) expect(seam.alpha, `${theme}/${viewport.width}px setup notch seam: ${JSON.stringify(seam)}`).toBe(0);
      for (const field of setupGeometry.outlineGeometry) {
        expect(field.notch?.rect, `${theme}/${viewport.width}px outline notch must render: ${JSON.stringify(field)}`).toBeDefined();
        expect(field.leading?.borderTopWidth, `${theme}/${viewport.width}px leading top outline must render: ${JSON.stringify(field)}`).not.toBe('0px');
        expect(field.trailing?.borderTopWidth, `${theme}/${viewport.width}px trailing top outline must render: ${JSON.stringify(field)}`).not.toBe('0px');
        expect(field.notch?.borderTopWidth, `${theme}/${viewport.width}px notch must continue the top outline: ${JSON.stringify(field)}`).toBe(field.leading?.borderTopWidth);
        expect(field.notch?.borderTopColor, `${theme}/${viewport.width}px notch top color must continue the top outline: ${JSON.stringify(field)}`).toBe(field.leading?.borderTopColor);
        expect(field.notch?.borderTopColor, `${theme}/${viewport.width}px notch top color must continue the top outline: ${JSON.stringify(field)}`).toBe(field.trailing?.borderTopColor);
      }
      for (const control of setupGeometry.controls) {
        expect(control.insideForm).toBeTruthy();
        expect(control.insideViewport).toBeTruthy();
      }
      expect(setupGeometry.controlsOverlap).toBeFalsy();
      await user.screenshot({path: testInfo.outputPath(`kyc-password-setup-${theme}-${viewport.width}.png`), fullPage: false});
    }
  }
  await setPassword(user);
  await user.locator('[formControlName="confirmPassword"]').fill('different-password');
  await expect(user.getByRole('button', {name: 'Set password'})).toBeDisabled();
  await expect(user.getByText('Passwords do not match.')).toBeVisible();
  await setPassword(user);
  let loginRequests = 0;
  user.on('request', outgoing => {
    if (outgoing.method() === 'POST' && new URL(outgoing.url()).pathname === '/api/auth/v2/login') loginRequests += 1;
  });
  const setupResponsePromise = user.waitForResponse(response => response.url().endsWith('/api/auth/v2/activate/setup') && response.request().method() === 'POST');
  await user.getByRole('button', {name: 'Set password'}).click();
  const setupResponse = await setupResponsePromise;
  expect(setupResponse.status()).toBe(200);
  const setupBody = setupResponse.request().postDataJSON() as Record<string, unknown>;
  expect(Object.keys(setupBody).sort()).toEqual(['device_id', 'device_name', 'password', 'token']);
  expect(typeof setupBody.token === 'string' && setupBody.token === new URL(initialSetupLink).hash.slice('#setup='.length)).toBeTruthy();
  expect(setupBody.password === password).toBeTruthy();
  expect(typeof setupBody.device_id === 'string' && setupBody.device_id.length > 0).toBeTruthy();
  expect(typeof setupBody.device_name === 'string' && setupBody.device_name.length > 0).toBeTruthy();
  const setupPayload = await setupResponse.json() as Record<string, unknown>;
  expect(Object.keys(setupPayload).sort()).toEqual(['access_token', 'browser_id', 'expires_in', 'generation', 'status', 'token_type']);
  expect(typeof setupPayload.access_token === 'string' && setupPayload.access_token.length > 0).toBeTruthy();
  expect(typeof setupPayload.browser_id === 'string' && setupPayload.browser_id.length > 0).toBeTruthy();
  expect(typeof setupPayload.generation === 'string' && setupPayload.generation.length > 0).toBeTruthy();
  expect(setupPayload.status).toBe('password_set');
  expect(setupPayload).not.toHaveProperty('refresh_token');
  await expect(user).toHaveURL(/\/home$/);
  const sessionCookies = (await userContext.cookies('https://chat.localhost/api/auth')).map(cookie => ({
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  }));
  expect(sessionCookies).toContainEqual({path: '/api/auth', httpOnly: true, secure: true, sameSite: 'None'});
  await expect(user.getByRole('heading', {name: 'Chats'})).toBeVisible();
  await expect(user.locator('.people-list .empty-rail')).toContainText('No conversations yet.');
  await expectNoVisibleNotchSeam(user, '.search-field', 'dark chat search field after password setup');
  await expect(user.getByRole('button', {name: 'Account menu'})).toBeVisible();
  expect(new URL(user.url()).hash).toBe('');
  expect(loginRequests).toBe(0);
  for (const theme of ['light', 'dark'] as const) {
    await user.evaluate(selectedTheme => {
      document.documentElement.classList.toggle('dark-theme', selectedTheme === 'dark');
      document.body.classList.toggle('dark-theme', selectedTheme === 'dark');
      document.documentElement.classList.toggle('light-theme', selectedTheme === 'light');
      document.body.classList.toggle('light-theme', selectedTheme === 'light');
    }, theme);
    for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
      await user.setViewportSize(viewport);
      expect(await user.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
      await expect(user.getByRole('heading', {name: 'Chats'})).toBeVisible();
      await expectNoVisibleNotchSeam(user, '.search-field', `${theme} ${viewport.width}px chat search field after password setup`);
      await user.screenshot({path: testInfo.outputPath(`kyc-password-setup-signed-in-${theme}-${viewport.width}.png`), fullPage: false});
    }
  }

  const searcherContext = await browser.newContext();
  const searcher = await searcherContext.newPage();
  await login(searcher, adminEmail);
  const searchResult = searcher.locator('.search-result').filter({hasText: pendingEmail});
  await searcher.getByPlaceholder('Name or email').fill(pendingEmail);
  await expect(searchResult).toBeVisible();

  const adminContext = await browser.newContext({httpCredentials: {username: basicAuthUser, password: basicAuthPassword}});
  const admin = await adminContext.newPage();
  await adminLogin(admin);
  await admin.screenshot({path: testInfo.outputPath('kyc-admin-dark.png'), fullPage: false});
  await captureTableBounds(admin, testInfo, 'kyc-admin-accounts');
  const setupAccountRow = admin.locator('tbody tr').filter({hasText: pendingEmail});
  await expect(setupAccountRow).toContainText('Active');
  await expect(setupAccountRow.getByRole('button', {name: 'Activate account'})).toBeDisabled();
  await expect(setupAccountRow.getByRole('button', {name: 'Block account'})).toBeEnabled();
  for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
    await admin.setViewportSize(viewport);
    const geometry = await admin.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.table-wrap');
      return {
        pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        tableReadyForScroll: !!table && getComputedStyle(table).overflowY === 'scroll' && getComputedStyle(table).overflowX === 'auto',
        tableContained: !!table && table.getBoundingClientRect().right <= document.documentElement.clientWidth + 1,
      };
    });
    expect(geometry.pageFits).toBeTruthy();
    expect(geometry.tableReadyForScroll).toBeTruthy();
    expect(geometry.tableContained).toBeTruthy();
    if (viewport.width === 390) {
      await assertPinnedTableSurfacesAreOpaque(admin);
      const mobileRow = setupAccountRow;
      await expect(mobileRow.getByText(pendingEmail)).toBeVisible();
      await expect(mobileRow.getByRole('button', {name: 'Activate account'})).toBeDisabled();
      await expect(mobileRow.getByRole('button', {name: 'Block account'})).toBeVisible();
      await expect(admin.getByText('Email and row actions stay visible.')).toBeVisible();
      const pinnedGeometry = await mobileRow.evaluate(row => {
        const table = row.closest<HTMLElement>('.table-wrap');
        const email = row.querySelector<HTMLElement>('td:first-child');
        const actions = row.querySelector<HTMLElement>('td:last-child');
        if (!table || !email || !actions) return null;
        table.scrollLeft = 0;
        const emailRect = email.getBoundingClientRect();
        const actionsRect = actions.getBoundingClientRect();
        return {emailLeft: emailRect.left, emailRight: emailRect.right, actionsLeft: actionsRect.left, actionsRight: actionsRect.right, tableLeft: table.getBoundingClientRect().left, tableRight: table.getBoundingClientRect().right, scrollWidth: table.scrollWidth, clientWidth: table.clientWidth};
      });
      if (!pinnedGeometry) throw new Error('account identity and action columns were not rendered');
      expect(pinnedGeometry.scrollWidth).toBeGreaterThan(pinnedGeometry.clientWidth);
      expect(pinnedGeometry.emailLeft).toBeGreaterThanOrEqual(pinnedGeometry.tableLeft - 1);
      expect(pinnedGeometry.actionsRight).toBeLessThanOrEqual(pinnedGeometry.tableRight + 1);
      expect(pinnedGeometry.emailRight).toBeLessThanOrEqual(pinnedGeometry.actionsLeft + 1);
      await admin.screenshot({path: testInfo.outputPath('kyc-admin-accounts-mobile-dark.png'), fullPage: false});
    }
  }
  await searcher.getByPlaceholder('Name or email').fill('');
  await searcher.getByPlaceholder('Name or email').fill(pendingEmail);
  await expect(searchResult).toBeVisible();

  await reloadAdmin(admin);
  const activeRow = admin.locator('tbody tr').filter({hasText: pendingEmail});
  await expect(activeRow.getByRole('button', {name: 'Activate account'})).toBeDisabled();
  await expect(activeRow.getByRole('button', {name: 'Resend activation link'})).toHaveCount(0);
  await expect(activeRow.getByRole('button', {name: 'Block account'})).toBeEnabled();
  await activeRow.getByRole('button', {name: 'Block account'}).click();
  await expect(admin.getByText('Account blocked.')).toBeVisible();
  // Blocking may invalidate the active page before reload, so no refresh is guaranteed.
  await user.goto("/home");
  await expect(user).toHaveURL(/\/login$/);
  await expect(user.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
  await searcher.getByPlaceholder('Name or email').fill('');
  await searcher.getByPlaceholder('Name or email').fill(pendingEmail);
  await expect(searchResult).toHaveCount(0);
  await admin.getByRole('button', {name: 'Invitations'}).click();
  await expect(admin.getByRole('heading', {name: 'Invitation codes'})).toBeVisible();
  await expect(admin.getByLabel('Invite email')).toBeVisible();
  await admin.getByRole('button', {name: 'Accounts'}).click();
  const blockedContext = await browser.newContext();
  const blocked = await blockedContext.newPage();
  await login(blocked, pendingEmail);
  await expect(blocked).toHaveURL(/\/login$/);
  await expect(blocked.getByText('account is not active')).toBeVisible();
  await reloadAdmin(admin);
  const blockedRow = admin.locator('tbody tr').filter({hasText: pendingEmail});
  await expect(blockedRow).toContainText('Blocked');
  await expect(blockedRow.getByRole('button', {name: 'Activate account'})).toBeEnabled();
  await expect(blockedRow.getByRole('button', {name: 'Block account'})).toBeDisabled();
  await blockedRow.getByRole('button', {name: 'Activate account'}).click();
  await expect(admin.getByText('Account activated.')).toBeVisible();
  await expect(admin.locator('tbody tr').filter({hasText: pendingEmail})).toContainText('Active');
  const reactivatedContext = await browser.newContext();
  const reactivated = await reactivatedContext.newPage();
  await login(reactivated, pendingEmail);
  await expect(reactivated).toHaveURL(/\/home$/);

  await expect((await request.get(`${adminBase}/api/admin/users`)).status()).toBe(401);
  await admin.setViewportSize({width: 390, height: 844});
  expect(await admin.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
  await admin.getByRole('button', {name: 'Account menu'}).click();
  await admin.getByRole('menuitem', {name: 'Profile'}).click();
  await expect(admin).toHaveURL(/\/profile$/);
  await expect(admin.getByRole('link', {name: 'Back to KYC admin'})).toBeVisible();
  await admin.getByRole('link', {name: 'Back to KYC admin'}).click();
  await expect(admin).toHaveURL(/\/admin$/);
  await admin.setViewportSize({width: 390, height: 844});
  const notificationClose = admin.getByRole('button', {name: 'Close'});
  if (await notificationClose.isVisible()) await notificationClose.click();
  await admin.getByRole('button', {name: 'Account menu'}).click();
  await admin.getByRole('menuitem', {name: 'Switch to light theme'}).click();
  await expect(admin.locator('html')).toHaveClass(/light-theme/);
  await expect.poll(() => admin.locator('.admin-page').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(246, 248, 252)');
  await admin.keyboard.press('Escape');
  await admin.screenshot({path: testInfo.outputPath('kyc-admin-light.png'), fullPage: false});
  await admin.getByRole('button', {name: 'Account menu'}).click();
  await admin.getByRole('menuitem', {name: 'Switch to dark theme'}).click();
  await expect(admin.locator('html')).toHaveClass(/dark-theme/);
  await expect.poll(() => admin.locator('.admin-page').evaluate(element => ({background: getComputedStyle(element).backgroundColor, classes: document.documentElement.className}))).toEqual({background: 'rgb(24, 35, 48)', classes: 'dark-theme'});
  await admin.getByRole('button', {name: 'Account menu'}).click();
  await admin.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(admin).toHaveURL(/\/login$/);
  await userContext.close();
  await adminContext.close();
  await searcherContext.close();
  await blockedContext.close();
  await reactivatedContext.close();
});

test('cached setup client falls back to legacy password setup only when v2 is unavailable', async ({browser, request}, testInfo) => {
  const email = uniqueEmail('legacy-setup-client');
  const context = await browser.newContext();
  const user = await context.newPage();
  await user.goto('/sign-up');
  await fillRegistration(user, email);
  const registration = user.waitForResponse(response => response.url().endsWith('/api/auth/v2/register') && response.request().method() === 'POST');
  await user.getByRole('button', {name: 'Create account'}).click();
  expect((await registration).status()).toBe(202);
  await expect(user).toHaveURL(/\/pending$/);

  await user.goto(await setupLink(request, email));
  await user.setViewportSize({width: 1440, height: 900});
  await expect(user.getByRole('heading', {name: 'Set your password'})).toBeVisible();
  let v2Requests = 0;
  let legacyRequests = 0;
  await user.route('**/api/auth/v2/activate/setup', async route => {
    v2Requests++;
    await route.fulfill({status: 404, contentType: 'application/json', body: JSON.stringify({error: 'not found'})});
  });
  user.on('request', outgoing => {
    if (outgoing.method() === 'POST' && new URL(outgoing.url()).pathname === '/api/auth/activate/setup') legacyRequests++;
  });
  await setPassword(user);
  const legacyResponsePromise = user.waitForResponse(response => response.url().endsWith('/api/auth/activate/setup') && response.request().method() === 'POST');
  await user.getByRole('button', {name: 'Set password'}).click();
  const legacyResponse = await legacyResponsePromise;
  expect(legacyResponse.status()).toBe(200);
  expect(legacyResponse.headers()['cache-control']).toBe('no-store');
  expect(await legacyResponse.json()).toEqual({status: 'password_set'});
  await expect(user.getByRole('heading', {name: 'Password setup complete'})).toBeVisible();
  await expect(user.getByRole('status')).toHaveText('Your password is set. An administrator must approve your account before you can sign in.');
  await expect(user.locator('app-notice .app-notice')).toHaveClass(/app-notice-info/);
  await expect(user.getByRole('button', {name: 'Back to login'})).toBeVisible();
  await expect(user.getByRole('button', {name: 'Account menu'})).toHaveCount(0);
  expect(v2Requests).toBe(1);
  expect(legacyRequests).toBe(1);
  expect((await context.cookies()).some(cookie => cookie.name.startsWith('zwei_refresh'))).toBe(false);
  const assertLegacySetupFeedbackContained = async (): Promise<void> => {
    const geometry = await user.evaluate(() => {
      const notice = document.querySelector<HTMLElement>('.auth-card app-notice');
      const button = document.querySelector<HTMLElement>('.auth-card button');
      const measure = (element: HTMLElement | null) => {
        const rect = element?.getBoundingClientRect();
        return rect && {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
      };
      return {documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
        viewportHeight: document.documentElement.clientHeight, notice: measure(notice), button: measure(button)};
    });
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    for (const [name, box] of [['notice', geometry.notice], ['button', geometry.button]] as const) {
      expect(box, `${name} should render in the legacy setup state`).not.toBeNull();
      expect(box!.left, `${name} left edge`).toBeGreaterThanOrEqual(0);
      expect(box!.right, `${name} right edge`).toBeLessThanOrEqual(geometry.viewportWidth + 1);
      expect(box!.top, `${name} top edge`).toBeGreaterThanOrEqual(0);
      expect(box!.bottom, `${name} bottom edge`).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    }
    expect(geometry.notice!.bottom).toBeLessThanOrEqual(geometry.button!.top + 1);
  };
  await expect(user.locator('html')).toHaveClass(/dark-theme/);
  await assertLegacySetupFeedbackContained();
  await user.screenshot({path: testInfo.outputPath('legacy-password-setup-dark-1440.png'), fullPage: false});
  await user.evaluate(() => { document.documentElement.classList.replace('dark-theme', 'light-theme'); document.body.classList.replace('dark-theme', 'light-theme'); });
  await user.setViewportSize({width: 390, height: 844});
  await expect(user.locator('html')).toHaveClass(/light-theme/);
  await assertLegacySetupFeedbackContained();
  await user.screenshot({path: testInfo.outputPath('legacy-password-setup-light-mobile.png'), fullPage: false});
  await user.getByRole('button', {name: 'Back to login'}).click();
  await expect(user).toHaveURL(/\/login$/);
  await expect(user.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
  await context.close();
});

test('approval before password setup rotates the emailed setup token', async ({browser, request}, testInfo) => {
  test.setTimeout(60_000);
  const email = uniqueEmail('approval-first');
  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  const registration = await register(user, email);
  expect(registration.status).toBe(202);
  const originalLink = await setupLink(request, email);

  const adminContext = await browser.newContext({httpCredentials: {username: basicAuthUser, password: basicAuthPassword}});
  const admin = await adminContext.newPage();
  await adminLogin(admin);
  const row = admin.locator('tbody tr').filter({hasText: email});
  const approval = admin.waitForResponse(response => response.url().includes('/api/admin/users/') && response.url().endsWith('/activate') && response.request().method() === 'POST');
  await row.getByRole('button', {name: 'Activate'}).click();
  expect((await approval).status()).toBe(204);
  const links = await activationLinks(request, email, 2);
  const replacementLink = links.find(link => link !== originalLink);
  if (!replacementLink) throw new Error('approval did not rotate the pending password setup token');
  expect(new URL(replacementLink).hash).not.toBe(new URL(originalLink).hash);

  await user.goto(originalLink);
  await expect(user.getByRole('heading', {name: 'Set your password'})).toBeVisible();
  await setPassword(user);
  const oldTokenRequest = user.waitForResponse(response => response.url().endsWith('/api/auth/v2/activate/setup') && response.request().method() === 'POST');
  await user.getByRole('button', {name: 'Set password'}).click();
  expect((await oldTokenRequest).status()).toBeGreaterThanOrEqual(400);
  await expect(user.getByRole('heading', {name: 'Password setup unavailable'})).toBeVisible();
  await expect(user.getByRole('alert')).toContainText('invalid, expired, or already used');
  expect(await user.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
  await user.screenshot({path: testInfo.outputPath('kyc-password-setup-invalid-dark.png'), fullPage: false});
  await user.evaluate(() => { document.documentElement.classList.remove('dark-theme'); document.body.classList.remove('dark-theme'); document.documentElement.classList.add('light-theme'); document.body.classList.add('light-theme'); });
  await user.setViewportSize({width: 390, height: 844});
  expect(await user.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBeTruthy();
  await user.screenshot({path: testInfo.outputPath('kyc-password-setup-invalid-light-mobile.png'), fullPage: false});

  await user.goto(replacementLink);
  await user.reload();
  await expect(user.getByRole('heading', {name: 'Set your password'})).toBeVisible();
  await setPassword(user);
  const newTokenRequest = user.waitForResponse(response => response.url().endsWith('/api/auth/v2/activate/setup') && response.request().method() === 'POST');
  await user.getByRole('button', {name: 'Set password'}).click();
  const setupResponse = await newTokenRequest;
  expect(setupResponse.status()).toBe(200);
  const setupPayload = await setupResponse.json() as Record<string, unknown>;
  expect(Object.keys(setupPayload).sort()).toEqual(['access_token', 'browser_id', 'expires_in', 'generation', 'status', 'token_type']);
  expect(typeof setupPayload.access_token === 'string' && setupPayload.access_token.length > 0).toBeTruthy();
  expect(typeof setupPayload.browser_id === 'string' && setupPayload.browser_id.length > 0).toBeTruthy();
  expect(typeof setupPayload.generation === 'string' && setupPayload.generation.length > 0).toBeTruthy();
  expect(setupPayload).not.toHaveProperty('refresh_token');
  await expect(user).toHaveURL(/\/home$/);
  await expect(user.getByRole('button', {name: 'Account menu'})).toBeVisible();
  expect(new URL(user.url()).hash).toBe('');
  await user.screenshot({path: testInfo.outputPath('kyc-password-setup-rotated-signed-in.png'), fullPage: false});
  await userContext.close();
  await adminContext.close();
});

test('invitation code activates and logs in an account, then cannot be reused', async ({browser, request}, testInfo) => {
  const invitedEmail = uniqueEmail('invited');
  const adminContext = await browser.newContext({httpCredentials: {username: basicAuthUser, password: basicAuthPassword}});
  const admin = await adminContext.newPage();
  await adminLogin(admin);
  await admin.getByRole('button', {name: 'Invitations'}).click();
  await admin.screenshot({path: testInfo.outputPath('kyc-invitations-empty.png'), fullPage: false});
  await admin.getByLabel('Invite email').fill(invitedEmail);
  const invitationForm = admin.locator('.invitation-form');
  const invitationTable = admin.locator('.invitation-section .table-wrap');
  const formGeometry = await invitationForm.evaluate(form => {
    const input = form.querySelector<HTMLElement>('mat-form-field');
    const button = form.querySelector<HTMLButtonElement>('button');
    return {inputHeight: input?.getBoundingClientRect().height ?? 0, buttonHeight: button?.getBoundingClientRect().height ?? 0, inputWidth: input?.getBoundingClientRect().width ?? 0, buttonWidth: button?.getBoundingClientRect().width ?? 0};
  });
  expect(Math.abs(formGeometry.inputHeight - formGeometry.buttonHeight)).toBeLessThanOrEqual(1);
  expect(formGeometry.inputWidth).toBeLessThan(700);
  expect(formGeometry.buttonWidth).toBeLessThanOrEqual(220);
  await expect(invitationTable).toBeVisible();
  const tableGap = await invitationTable.evaluate(table => table.getBoundingClientRect().top - table.previousElementSibling!.getBoundingClientRect().bottom);
  expect(tableGap).toBeGreaterThanOrEqual(16);
  for (const theme of ['dark', 'light'] as const) {
    await switchAdminTheme(admin, theme);
    for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
      await admin.setViewportSize(viewport);
      await assertInvitationFieldContrastAndContainment(admin);
      const input = admin.locator('.invitation-form input');
      await input.focus();
      await admin.keyboard.press('Tab');
      await admin.keyboard.press('Shift+Tab');
      await expect(input).toBeFocused();
      await input.press('End');
      const breakpoint = viewport.width === 390 ? 'mobile' : 'desktop';
      await admin.screenshot({path: testInfo.outputPath(`kyc-invitations-form-${theme}-${breakpoint}.png`), fullPage: false});
    }
  }
  await switchAdminTheme(admin, 'dark');
  await admin.setViewportSize({width: 1440, height: 900});
  await admin.screenshot({path: testInfo.outputPath('kyc-invitations-form.png'), fullPage: false});
  await admin.getByRole('button', {name: 'Create invitation'}).click();
  const code = await admin.locator('.created-code code').textContent();
  expect(code).toBeTruthy();
  const emailedLink = await invitationLink(request, invitedEmail);
  expect(new URL(emailedLink).searchParams.get('code')).toBe(code);
  const availableInvitation = admin.locator('tbody tr').filter({hasText: invitedEmail});
  await expect(availableInvitation.getByRole('button', {name: 'Expire invitation'})).toBeEnabled();
  await admin.screenshot({path: testInfo.outputPath('kyc-invitation-available.png'), fullPage: false});

  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  const registration = await registerFromInvitationLink(user, invitedEmail, emailedLink);
  expect(registration.status).toBe(201);
  expect(registration.accessToken).toBeTruthy();
  await expect(user).toHaveURL(/\/home$/);
  const nonAdminResponse = await request.get(`${adminBase}/api/admin/users`, {
    headers: {Authorization: `Bearer ${registration.accessToken}`},
  });
  expect(nonAdminResponse.status()).toBe(403);
  await user.getByRole('button', {name: 'Account menu'}).click();
  await user.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(user).toHaveURL(/\/login$/);
  await user.getByRole('link', {name: 'Create one'}).click();
  await expect(user).toHaveURL(/\/sign-up$/);
  for (const fieldName of ['email', 'firstName', 'lastName', 'nickName']) {
    await expect(user.locator(`[formControlName="${fieldName}"]`)).toHaveValue('');
  }
  await expect(user.locator('[formControlName="password"]')).toHaveCount(0);
  await reloadAdmin(admin);
  await admin.getByRole('button', {name: 'Invitations'}).click();
  const redeemedInvitation = admin.locator('tbody tr').filter({hasText: invitedEmail});
  await expect(redeemedInvitation).toContainText('Redeemed');
  await expect(redeemedInvitation.getByRole('button', {name: 'Expire invitation'})).toBeDisabled();

  const mismatch = await browser.newPage();
  const mismatchResponse = await register(mismatch, uniqueEmail('wrong-invite'), code || undefined);
  expect(mismatchResponse.status).toBe(400);
  await expect(mismatch.getByText('invalid invitation code')).toBeVisible();

  await userContext.close();
  await adminContext.close();
  await mismatch.close();
});
