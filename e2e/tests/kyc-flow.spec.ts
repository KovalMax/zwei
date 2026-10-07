import {expect, Page, APIRequestContext, TestInfo, test} from '@playwright/test';

const password = process.env.E2E_ADMIN_PASSWORD ?? 'Password123!';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';
const adminBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const basicAuthUser = process.env.KYC_BASIC_AUTH_USER ?? 'kyc-admin';
const basicAuthPassword = process.env.KYC_BASIC_AUTH_PASSWORD ?? 'local-basic-auth-change-me';

function uniqueEmail(name: string): string {
  return `e2e-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
}

async function fillRegistration(page: Page, email: string): Promise<void> {
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="firstName"]').fill('Kyc');
  await page.locator('[formControlName="lastName"]').fill('Test');
  await page.locator('[formControlName="nickName"]').fill('Kyc Test');
  await page.locator('[formControlName="password"]').fill(password);
  await page.locator('[formControlName="confirmPassword"]').fill(password);
}

async function register(page: Page, email: string, invitationCode?: string): Promise<{status: number; accessToken?: string}> {
  const suffix = invitationCode ? `?invite=1&code=${encodeURIComponent(invitationCode)}` : '';
  await page.goto(`/sign-up${suffix}`);
  await fillRegistration(page, email);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create account'}).click();
  const response = await responsePromise;
  const payload = await response.json() as {access_token?: string};
  return {status: response.status(), accessToken: payload.access_token};
}

async function registerFromInvitationLink(page: Page, email: string, link: string): Promise<{status: number; accessToken?: string}> {
  await page.goto(link);
  await fillRegistration(page, email);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create account'}).click();
  const response = await responsePromise;
  const payload = await response.json() as {access_token?: string};
  return {status: response.status(), accessToken: payload.access_token};
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
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

async function reloadAdmin(page: Page): Promise<void> {
  const refresh = page.waitForResponse(response => response.url().endsWith('/api/auth/refresh') && response.request().method() === 'POST');
  await page.reload();
  const response = await refresh;
  expect(response.status(), `refresh failed: ${await response.text()}`).toBe(200);
  await expect(page).toHaveURL(/\/admin$/);
}

async function activationLink(request: APIRequestContext, email: string): Promise<string> {
  const links = await activationLinks(request, email);
  return links[0];
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
      const text = JSON.stringify(await detail.json());
      const link = text.match(/https:\/\/chat\.localhost\/activate\?token=[A-Za-z0-9_-]+/)?.[0];
      if (link) links.push(link);
    }
    return links.length;
  }, {timeout: 10_000}).toBeGreaterThanOrEqual(minimum);
  return links;
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
  await expect(rows.first()).toBeVisible();
  await page.screenshot({path: testInfo.outputPath(`${name}-top.png`), fullPage: false});

  const end = await table.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    return {scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight};
  });
  expect(end.scrollTop).toBeGreaterThanOrEqual(Math.max(0, end.scrollHeight - end.clientHeight) - 1);
  await expect(rows.last()).toBeVisible();
  await page.screenshot({path: testInfo.outputPath(`${name}-end.png`), fullPage: false});
  await table.evaluate(element => { element.scrollTop = 0; });
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
  expect((await request.get(`${adminBase}/`)).status()).toBe(401);
  const pendingEmail = uniqueEmail('pending');
  const userContext = await browser.newContext();
  const user = await userContext.newPage();
  const registration = await register(user, pendingEmail);
  expect(registration.status).toBe(202);
  expect(registration.accessToken).toBeUndefined();
  await expect(user).toHaveURL(/\/pending$/);
  await expect(user.locator('.auth-card')).toBeVisible();
  const pendingCardWidth = await user.locator('.auth-card').evaluate(element => element.getBoundingClientRect().width);
  expect(pendingCardWidth).toBeLessThanOrEqual(440);
  await user.screenshot({path: testInfo.outputPath('kyc-pending-dark.png'), fullPage: false});
  await user.evaluate(() => localStorage.setItem('zwei_theme', 'light'));
  await user.reload();
  await expect(user.locator('html')).toHaveClass(/light-theme/);
  await user.screenshot({path: testInfo.outputPath('kyc-pending-light.png'), fullPage: false});
  await login(user, pendingEmail);
  await expect(user).toHaveURL(/\/login$/);
  await expect(user.getByText('account is not active')).toBeVisible();

  const searcherContext = await browser.newContext();
  const searcher = await searcherContext.newPage();
  await login(searcher, adminEmail);
  const searchResult = searcher.locator('.search-result').filter({hasText: pendingEmail});
  await searcher.getByPlaceholder('Name or email').fill(pendingEmail);
  await expect(searchResult).toHaveCount(0);

  const adminContext = await browser.newContext({httpCredentials: {username: basicAuthUser, password: basicAuthPassword}});
  const admin = await adminContext.newPage();
  await adminLogin(admin);
  await admin.screenshot({path: testInfo.outputPath('kyc-admin-dark.png'), fullPage: false});
  await captureTableBounds(admin, testInfo, 'kyc-admin-accounts');
  const pendingRow = admin.locator('tbody tr').filter({hasText: pendingEmail});
  await expect(pendingRow).toContainText('Pending');
  await expect(pendingRow.getByRole('button', {name: 'Activate account'})).toBeEnabled();
  await expect(pendingRow.getByRole('button', {name: 'Block account'})).toBeEnabled();
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
      const mobileRow = admin.locator('tbody tr').filter({hasText: pendingEmail});
      await expect(mobileRow.getByText(pendingEmail)).toBeVisible();
      await expect(mobileRow.getByRole('button', {name: 'Activate account'})).toBeVisible();
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
  const activationResponsePromise = admin.waitForResponse(response => response.url().includes('/api/admin/users/') && response.url().endsWith('/activate') && response.request().method() === 'POST');
  await pendingRow.getByRole('button', {name: 'Activate'}).click();
  const activationResponse = await activationResponsePromise;
  expect(activationResponse.status()).toBe(204);
  await expect(admin.getByText('Account activated.')).toBeVisible();

  const firstLink = await activationLink(request, pendingEmail);
  await reloadAdmin(admin);
  const activePendingRow = admin.locator('tbody tr').filter({hasText: pendingEmail});
  await expect(activePendingRow).toContainText('Active');
  await expect(activePendingRow.getByRole('button', {name: 'Resend activation link'})).toBeEnabled();
  const resendResponsePromise = admin.waitForResponse(response => response.url().includes('/api/admin/users/') && response.url().endsWith('/resend-activation') && response.request().method() === 'POST');
  await activePendingRow.getByRole('button', {name: 'Resend activation link'}).click();
  const resendResponse = await resendResponsePromise;
  expect(resendResponse.status()).toBe(204);
  await expect(admin.getByText('Activation link sent.')).toBeVisible();
  const resendButton = admin.locator('tbody tr').filter({hasText: pendingEmail}).getByRole('button', {name: 'Resend activation link'});
  await expect(resendButton).toBeEnabled();
  const assertResendFeedbackDoesNotCoverRow = async (): Promise<void> => {
    const feedback = admin.getByRole('status').filter({hasText: 'Activation link sent.'});
    await expect(feedback).toBeVisible();
    const geometry = await feedback.evaluate(element => {
      const table = element.parentElement?.querySelector<HTMLElement>('.table-wrap');
      const feedbackRect = element.getBoundingClientRect();
      const tableRect = table?.getBoundingClientRect();
      return tableRect ? {feedbackBottom: feedbackRect.bottom, tableTop: tableRect.top, feedbackLeft: feedbackRect.left, feedbackRight: feedbackRect.right, tableLeft: tableRect.left, tableRight: tableRect.right} : null;
    });
    if (!geometry) throw new Error('account feedback and table geometry were not rendered');
    expect(geometry.feedbackBottom).toBeLessThanOrEqual(geometry.tableTop);
    expect(geometry.feedbackLeft).toBeGreaterThanOrEqual(geometry.tableLeft - 1);
    expect(geometry.feedbackRight).toBeLessThanOrEqual(geometry.tableRight + 1);
    const row = admin.locator('tbody tr').filter({hasText: pendingEmail});
    await expect(row.getByText(pendingEmail)).toBeVisible();
    await expect(row.getByRole('button', {name: 'Resend activation link'})).toBeEnabled();
    await expect(row.getByRole('button', {name: 'Block account'})).toBeEnabled();
    for (const label of ['Resend activation link', 'Block account']) {
      const receivesPointer = await row.getByRole('button', {name: label}).evaluate(button => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit === button || button.contains(hit);
      });
      expect(receivesPointer, `${label} remains the hit target`).toBeTruthy();
    }
  };
  await admin.setViewportSize({width: 1440, height: 900});
  await admin.screenshot({path: testInfo.outputPath('kyc-admin-resend-desktop.png'), fullPage: false});
  await admin.setViewportSize({width: 390, height: 844});
  await assertResendFeedbackDoesNotCoverRow();
  await assertPinnedTableSurfacesAreOpaque(admin);
  await expect(admin.locator('tbody tr').filter({hasText: pendingEmail}).getByText(pendingEmail)).toBeVisible();
  const resendGeometry = await resendButton.evaluate(button => {
    const table = button.closest<HTMLElement>('.table-wrap');
    if (!table) return null;
    table.scrollLeft = table.scrollWidth;
    const rect = button.getBoundingClientRect();
    return {left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth};
  });
  if (!resendGeometry) throw new Error('resend action is not inside the table');
  expect(resendGeometry.left).toBeGreaterThanOrEqual(0);
  expect(resendGeometry.right).toBeLessThanOrEqual(resendGeometry.viewport + 1);
  await expect(resendButton).toBeVisible();
  await expect(admin.locator('tbody tr').filter({hasText: pendingEmail}).getByRole('button', {name: 'Block account'})).toBeVisible();
  await admin.screenshot({path: testInfo.outputPath('kyc-admin-resend-mobile.png'), fullPage: false});
  await admin.getByRole('button', {name: 'Account menu'}).click();
  await admin.getByRole('menuitem', {name: 'Switch to light theme'}).click();
  await expect(admin.locator('html')).toHaveClass(/light-theme/);
  await admin.keyboard.press('Escape');
  await expect(admin.getByRole('menuitem', {name: 'Switch to dark theme'})).toHaveCount(0);
  await admin.setViewportSize({width: 1440, height: 900});
  await admin.screenshot({path: testInfo.outputPath('kyc-admin-resend-light.png'), fullPage: false});
  await admin.setViewportSize({width: 390, height: 844});
  await assertResendFeedbackDoesNotCoverRow();
  await expect(admin.locator('tbody tr').filter({hasText: pendingEmail}).getByText(pendingEmail)).toBeVisible();
  await expect(admin.locator('tbody tr').filter({hasText: pendingEmail}).getByRole('button', {name: 'Block account'})).toBeEnabled();
  await expect(admin.locator('tbody tr').filter({hasText: pendingEmail}).getByRole('button', {name: 'Resend activation link'})).toBeVisible();
  await admin.screenshot({path: testInfo.outputPath('kyc-admin-resend-light-mobile.png'), fullPage: false});
  await admin.setViewportSize({width: 1440, height: 900});
  await admin.getByRole('button', {name: 'Account menu'}).click();
  await admin.getByRole('menuitem', {name: 'Switch to dark theme'}).click();
  await expect(admin.locator('html')).toHaveClass(/dark-theme/);
  const activationMessages = await activationLinks(request, pendingEmail, 2);
  const secondLink = activationMessages.find(candidate => candidate !== firstLink);
  if (!secondLink) throw new Error('resend did not produce a new activation link');
  await searcher.getByPlaceholder('Name or email').fill('');
  await searcher.getByPlaceholder('Name or email').fill(pendingEmail);
  await expect(searchResult).toHaveCount(0);
  await user.evaluate(() => localStorage.setItem('zwei_theme', 'dark'));
  await user.goto(firstLink);
  await expect(user.getByRole('heading', {name: 'Activation link unavailable'})).toBeVisible();
  await user.goto(secondLink);
  await expect(user.getByRole('heading', {name: 'Your account is active'})).toBeVisible();
  await expect(user.locator('.auth-card')).toBeVisible();
  await user.screenshot({path: testInfo.outputPath('kyc-activation-dark.png'), fullPage: false});
  await user.getByRole('button', {name: 'Continue to sign in'}).click();
  await user.goto(secondLink);
  await expect(user.getByRole('heading', {name: 'Activation link unavailable'})).toBeVisible();
  await login(user, pendingEmail);
  await expect(user).toHaveURL(/\/home$/);
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
  await user.reload();
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
  for (const fieldName of ['email', 'firstName', 'lastName', 'nickName', 'password', 'confirmPassword']) {
    await expect(user.locator(`[formControlName="${fieldName}"]`)).toHaveValue('');
  }
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
