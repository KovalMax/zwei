import {expect, Page, test} from '@playwright/test';

const authBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const chatBase = process.env.CHAT_BASE_URL ?? 'https://chat.localhost';
const password = 'Password123!';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';
const paginationViewports = [
  {width: 2560, height: 1440},
  {width: 1440, height: 900},
  {width: 1024, height: 900},
  {width: 390, height: 844},
] as const;

type Token = {access_token: string; token_type: string};
type GroupWire = {id: string; name: string};
type GroupPageWire = {items: GroupWire[]; next_cursor: string | null};

function uniqueEmail(name: string): string {
  return `e2e-pagination-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
}

async function register(page: Page, email: string, name: string): Promise<void> {
  const admin = await page.request.post(`${authBase}/api/auth/login`, {data: {email: adminEmail, password, device_id: `pagination-admin-${Date.now()}-${Math.random()}`, device_name: 'E2E'}});
  expect(admin.status()).toBe(200);
  const adminToken = await admin.json() as Token;
  const invitation = await page.request.post(`${authBase}/api/admin/invitations`, {headers: {Authorization: `${adminToken.token_type} ${adminToken.access_token}`}, data: {email}});
  expect(invitation.status()).toBe(201);
  const {code} = await invitation.json() as {code: string};
  await page.goto(`/sign-up?invite=1&code=${encodeURIComponent(code)}`);
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="firstName"]').fill(name);
  await page.locator('[formControlName="lastName"]').fill('Pagination');
  await page.locator('[formControlName="nickName"]').fill(name);
  await page.locator('[formControlName="password"]').fill(password);
  await page.locator('[formControlName="confirmPassword"]').fill(password);
  const response = page.waitForResponse(item => item.url().endsWith('/api/auth/register') && item.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create account'}).click();
  expect((await response).status()).toBe(201);
  await expect(page).toHaveURL(/\/home$/);
}

async function loginToken(page: Page, email: string): Promise<Token> {
  const response = await page.request.post(`${authBase}/api/auth/login`, {data: {email, password, device_id: `pagination-${Date.now()}-${Math.random()}`, device_name: 'E2E'}});
  expect(response.status()).toBe(200);
  return response.json() as Promise<Token>;
}

async function userID(page: Page, token: Token, email: string): Promise<string> {
  const response = await page.request.get(`${chatBase}/api/chat/users/search?q=${encodeURIComponent(email)}`, {headers: {Authorization: `${token.token_type} ${token.access_token}`}});
  expect(response.status()).toBe(200);
  const match = (await response.json() as Array<{id: string; email: string}>).find(user => user.email === email);
  if (!match) throw new Error(`Could not resolve test account ${email}`);
  return match.id;
}

async function createGroups(page: Page, token: Token, targetID: string, ownerLabel: string): Promise<GroupWire[]> {
  const groups: GroupWire[] = [];
  for (let index = 1; index <= 13; index++) {
    const name = `Pagination ${ownerLabel} ${index.toString().padStart(2, '0')}`;
    const response = await page.request.post(`${chatBase}/api/chat/groups`, {
      headers: {Authorization: `${token.token_type} ${token.access_token}`},
      data: {name, member_ids: [targetID]},
    });
    expect(response.status(), `create ${name}`).toBe(201);
    const group = await response.json() as GroupWire;
    groups.push(group);
  }
  return groups;
}

async function expectGroupPageErrorAppearance(page: Page, width: number): Promise<void> {
  const appearance = await page.getByRole('alert').filter({hasText: 'Could not load more groups.'}).evaluate(alert => {
    const list = document.querySelector<HTMLElement>('.people-list');
    if (!list) throw new Error('Group list is missing from the error state');
    list.scrollTop = list.scrollHeight;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.person-option'));
    const lastRow = rows.at(-1);
    if (!lastRow) throw new Error('Group rows disappeared from the cursor-error state');
    const control = alert.querySelector('button');
    if (!control) throw new Error('Group-page alert is missing its retry control');
    const style = getComputedStyle(alert);
    const controlStyle = getComputedStyle(control);
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height};
    };
    const contrast = (foreground: string, background: string): number => {
      const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      const rgb = (value: string): number[] => {
        const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        if (!channels || channels.length !== 3) throw new Error(`Could not parse computed color ${value}`);
        return channels;
      };
      const luminance = (value: string) => {
        const [red, green, blue] = rgb(value).map(channel);
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    };
    return {
      alert: rect(alert),
      control: rect(control),
      alertBackground: style.backgroundColor,
      alertBorder: style.borderTopColor,
      alertBorderStyle: style.borderTopStyle,
      alertTextContrast: contrast(style.color, style.backgroundColor),
      controlBackground: controlStyle.backgroundColor,
      controlTextContrast: contrast(controlStyle.color, controlStyle.backgroundColor),
      controlHeight: control.getBoundingClientRect().height,
      controlOutlineStyle: controlStyle.outlineStyle,
      controlOutlineWidth: controlStyle.outlineWidth,
      desktopLayout: innerWidth > 600 ? (() => {
        const header = document.querySelector('.chat-header');
        const composer = document.querySelector('.composer');
        const sendButton = composer?.querySelector('button');
        const appContent = document.querySelector('.app-content');
        if (!header || !composer || !sendButton || !appContent) {
          throw new Error(`Missing desktop layout element: ${JSON.stringify({header: !!header, composer: !!composer, sendButton: !!sendButton, appContent: !!appContent})}`);
        }
        const headerRect = header.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        const sendRect = sendButton.getBoundingClientRect();
        const appContentRect = appContent.getBoundingClientRect();
        const overlaps = (left: DOMRect, right: DOMRect) => left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
        const emptyChat = document.querySelector<HTMLElement>('.chat-empty');
        return {
          header: rect(header),
          composer: rect(composer),
          sendButton: rect(sendButton),
          appContent: rect(appContent),
          composerHeaderOverlap: overlaps(headerRect, composerRect),
          composerViewportContained: composerRect.left >= 0 && composerRect.right <= innerWidth && composerRect.top >= 0 && composerRect.bottom <= innerHeight,
          composerAppContentContained: composerRect.left >= appContentRect.left && composerRect.right <= appContentRect.right && composerRect.top >= appContentRect.top && composerRect.bottom <= appContentRect.bottom,
          sendButtonAppContentContained: sendRect.left >= appContentRect.left && sendRect.right <= appContentRect.right && sendRect.top >= appContentRect.top && sendRect.bottom <= appContentRect.bottom,
          sendButtonComposerContained: sendRect.left >= composerRect.left && sendRect.right <= composerRect.right && sendRect.top >= composerRect.top && sendRect.bottom <= composerRect.bottom,
          sendButtonViewportContained: sendRect.left >= 0 && sendRect.right <= innerWidth && sendRect.top >= 0 && sendRect.bottom <= innerHeight,
          sendButtonHeaderOverlap: overlaps(headerRect, sendRect),
          emptyChatVisible: !!emptyChat && getComputedStyle(emptyChat).display !== 'none' && emptyChat.getBoundingClientRect().height > 0,
        };
      })() : null,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      rail: rect(document.querySelector('.people-list') ?? alert),
      railClientWidth: (document.querySelector('.people-list') as HTMLElement | null)?.clientWidth ?? 0,
      railScrollWidth: (document.querySelector('.people-list') as HTMLElement | null)?.scrollWidth ?? 0,
      railScrollTop: list.scrollTop,
      railScrollHeight: list.scrollHeight,
      railClientHeight: list.clientHeight,
      lastRow: rect(lastRow),
      partiallyClippedRows: rows.filter(row => {
        const bounds = row.getBoundingClientRect();
        const railBounds = list.getBoundingClientRect();
        return bounds.top < railBounds.top && bounds.bottom > railBounds.top || bounds.top < railBounds.bottom && bounds.bottom > railBounds.bottom;
      }).length,
    };
  });

  expect(appearance.alertBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(appearance.alertBorderStyle).toBe('solid');
  expect(appearance.alertBorder).not.toBe(appearance.alertBackground);
  expect(appearance.alertTextContrast).toBeGreaterThanOrEqual(4.5);
  expect(appearance.controlTextContrast).toBeGreaterThanOrEqual(4.5);
  expect(appearance.controlHeight).toBeGreaterThanOrEqual(44);
  expect(appearance.controlOutlineStyle).toBe('solid');
  expect(appearance.controlOutlineWidth).toBe('3px');
  expect(appearance.control.left).toBeGreaterThanOrEqual(appearance.alert.left);
  expect(appearance.control.right).toBeLessThanOrEqual(appearance.alert.right);
  expect(appearance.alert.left).toBeGreaterThanOrEqual(appearance.rail.left);
  expect(appearance.alert.right).toBeLessThanOrEqual(appearance.rail.right);
  expect(appearance.alert.top).toBeGreaterThanOrEqual(0);
  expect(appearance.alert.bottom).toBeLessThanOrEqual(appearance.viewportHeight);
  expect(appearance.control.top).toBeGreaterThanOrEqual(0);
  expect(appearance.control.bottom).toBeLessThanOrEqual(appearance.viewportHeight);
  expect(appearance.railScrollTop + appearance.railClientHeight).toBeGreaterThanOrEqual(appearance.railScrollHeight - 1);
  expect(appearance.lastRow.top, `Last group row starts above the visible rail: ${JSON.stringify(appearance)}`).toBeGreaterThanOrEqual(appearance.rail.top);
  expect(appearance.lastRow.bottom, `Last group row is clipped at the visible rail end: ${JSON.stringify(appearance)}`).toBeLessThanOrEqual(appearance.rail.bottom);
  // A partially visible earlier row at the scrollport's top is normal when
  // parked at scroll end; no row may be clipped at the bottom and the final
  // row plus retry alert must remain completely reachable in that same view.
  expect(appearance.partiallyClippedRows, `Unexpected row clipping outside the ordinary scroll boundary: ${JSON.stringify(appearance)}`).toBeLessThanOrEqual(1);
  console.log(`Cursor-error rail geometry ${width}x${appearance.viewportHeight}: ${JSON.stringify({scrollTop: appearance.railScrollTop, scrollHeight: appearance.railScrollHeight, clientHeight: appearance.railClientHeight, rail: appearance.rail, lastRow: appearance.lastRow, alert: appearance.alert, partiallyClippedRows: appearance.partiallyClippedRows})}`);
  expect(appearance.alert.top, `Cursor error is above the visible rail: ${JSON.stringify(appearance)}`).toBeGreaterThanOrEqual(appearance.rail.top);
  expect(appearance.alert.bottom, `Cursor error is clipped at the visible rail end: ${JSON.stringify(appearance)}`).toBeLessThanOrEqual(appearance.rail.bottom);
  expect(appearance.documentWidth).toBeLessThanOrEqual(width);
  expect(appearance.railScrollWidth).toBeLessThanOrEqual(appearance.railClientWidth + 1);
  if (width > 600) {
    console.log(`Group-page error desktop geometry ${width}x${appearance.viewportHeight}: ${JSON.stringify(appearance.desktopLayout)}`);
    expect.soft(appearance.desktopLayout, `Desktop composer geometry: ${JSON.stringify(appearance.desktopLayout)}`).not.toBeNull();
    expect.soft(appearance.desktopLayout?.composerViewportContained, `Composer outside viewport: ${JSON.stringify(appearance.desktopLayout)}`).toBe(true);
    expect.soft(appearance.desktopLayout?.composerAppContentContained, `Composer outside app content: ${JSON.stringify(appearance.desktopLayout)}`).toBe(true);
    expect.soft(appearance.desktopLayout?.sendButtonAppContentContained, `Send button outside app content: ${JSON.stringify(appearance.desktopLayout)}`).toBe(true);
    expect.soft(appearance.desktopLayout?.sendButtonComposerContained, `Send button outside composer: ${JSON.stringify(appearance.desktopLayout)}`).toBe(true);
    expect.soft(appearance.desktopLayout?.sendButtonViewportContained, `Send button outside viewport: ${JSON.stringify(appearance.desktopLayout)}`).toBe(true);
    expect.soft(appearance.desktopLayout?.composerHeaderOverlap, `Composer overlaps chat header: ${JSON.stringify(appearance.desktopLayout)}`).toBe(false);
    expect.soft(appearance.desktopLayout?.sendButtonHeaderOverlap, `Send button overlaps chat header: ${JSON.stringify(appearance.desktopLayout)}`).toBe(false);
    expect.soft(appearance.desktopLayout?.emptyChatVisible, `Empty chat is not visible: ${JSON.stringify(appearance.desktopLayout)}`).toBe(true);
  }
}

async function expectAccountMenuOverlayRemoved(page: Page): Promise<void> {
  // Material marks menu content aria-hidden as soon as closing starts, before
  // the exit animation finishes. Role-based hidden assertions therefore do
  // not prove that the visually covering panel/backdrop has gone away.
  await expect(page.locator('.cdk-overlay-pane .mat-mdc-menu-panel')).toHaveCount(0);
  await expect(page.locator('.cdk-overlay-backdrop')).toHaveCount(0);
}

async function expectAccountMenuOverlayOpen(page: Page): Promise<void> {
  await expect(page.locator('.cdk-overlay-pane .mat-mdc-menu-panel')).toBeVisible();
  await expect(page.locator('.cdk-overlay-backdrop')).toHaveCount(1);
}

test('loads 26 shared groups by pages and keeps the rail contained across theme/viewport matrix', async ({browser}, testInfo) => {
  const ownerOneEmail = uniqueEmail('owner-one');
  const ownerTwoEmail = uniqueEmail('owner-two');
  const targetEmail = uniqueEmail('shared-target');
  const ownerOneContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const ownerTwoContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const targetContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const ownerOne = await ownerOneContext.newPage();
  const ownerTwo = await ownerTwoContext.newPage();
  let target = await targetContext.newPage();
  try {
    await register(ownerOne, ownerOneEmail, 'Owner One');
    await register(ownerTwo, ownerTwoEmail, 'Owner Two');
    await register(target, targetEmail, 'Shared Target');
    const [ownerOneToken, ownerTwoToken] = await Promise.all([loginToken(ownerOne, ownerOneEmail), loginToken(ownerTwo, ownerTwoEmail)]);
    const [ownerOneTargetID, ownerTwoTargetID] = await Promise.all([userID(ownerOne, ownerOneToken, targetEmail), userID(ownerTwo, ownerTwoToken, targetEmail)]);
    expect(ownerTwoTargetID).toBe(ownerOneTargetID);
    // Keep the target offline while the owners create groups. Otherwise the
    // 26 conversation.created events can race first-page refreshes: a refresh
    // that omits a previously observed group correctly quarantines it as a
    // generic verification row, independently of the 25-row page contract.
    await target.close();
    const [firstOwnerGroups, secondOwnerGroups] = await Promise.all([
      createGroups(ownerOne, ownerOneToken, ownerOneTargetID, 'One'),
      createGroups(ownerTwo, ownerTwoToken, ownerTwoTargetID, 'Two'),
    ]);
    const expectedGroups = [...firstOwnerGroups, ...secondOwnerGroups];
    const expectedNames = expectedGroups.map(group => group.name).sort();

    target = await targetContext.newPage();
    const firstPageResponsePromise = target.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/chat/groups' && url.searchParams.get('limit') === '25' && !url.searchParams.has('cursor');
    });
    await target.goto('/home');
    const firstPageResponse = await firstPageResponsePromise;
    expect(firstPageResponse.status()).toBe(200);
    const firstPage = await firstPageResponse.json() as GroupPageWire;
    expect(firstPage.items).toHaveLength(25);
    expect(firstPage.next_cursor).toBeTruthy();
    const renderedFirstPage = await target.locator('.person-option').evaluateAll(rows => rows.map(row => ({id: row.getAttribute('data-conversation-id'), name: row.querySelector('strong')?.textContent?.trim() ?? ''})));
    expect(renderedFirstPage).toHaveLength(25);
    const firstPageIDs = renderedFirstPage.map(row => row.id);
    expect(firstPageIDs).toHaveLength(25);
    expect(new Set(firstPageIDs).size).toBe(25);
    const authorizedPageRows = firstPage.items.map(group => ({id: group.id, name: group.name}));
    expect([...renderedFirstPage].sort((left, right) => (left.id ?? '').localeCompare(right.id ?? ''))).toEqual([...authorizedPageRows].sort((left, right) => left.id.localeCompare(right.id)));
    expect(renderedFirstPage.some(row => row.name === 'Group access needs verification')).toBe(false);
    for (const theme of ['dark', 'light'] as const) {
      for (const viewport of paginationViewports) {
        const {width, height} = viewport;
        await target.setViewportSize(viewport);
        const lightTheme = await target.locator('html').evaluate(element => element.classList.contains('light-theme'));
        if (lightTheme !== (theme === 'light')) {
          await target.getByRole('button', {name: 'Account menu'}).click();
          await expectAccountMenuOverlayOpen(target);
          await target.getByRole('menuitem', {name: theme === 'light' ? 'Switch to light theme' : 'Switch to dark theme'}).click();
          await expectAccountMenuOverlayRemoved(target);
        }
        const list = target.locator('.people-list');
        await list.evaluate(element => { element.scrollTop = 0; });
        await expect(list.locator('.person-option').first()).toBeVisible();
        const start = await target.evaluate(() => ({documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, listWidth: document.querySelector<HTMLElement>('.people-list')?.clientWidth ?? 0, listScrollWidth: document.querySelector<HTMLElement>('.people-list')?.scrollWidth ?? 0}));
        expect(start.documentWidth).toBeLessThanOrEqual(start.viewportWidth);
        expect(start.listScrollWidth).toBeLessThanOrEqual(start.listWidth + 1);
      await target.screenshot({path: testInfo.outputPath(`groups-first-page-${theme}-${width}x${height}-top.png`)});
      await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(list.locator('.person-option').last()).toBeVisible();
      const endGeometry = await list.evaluate(element => {
        const rows = element.querySelectorAll<HTMLElement>('.person-option');
        const lastRow = rows.item(rows.length - 1);
        if (!lastRow) throw new Error('Last group row is missing');
        const listRect = element.getBoundingClientRect();
        const rowRect = lastRow.getBoundingClientRect();
        return {scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, listTop: listRect.top, listBottom: listRect.bottom, rowTop: rowRect.top, rowBottom: rowRect.bottom};
      });
      expect(endGeometry.scrollTop + endGeometry.clientHeight).toBeGreaterThanOrEqual(endGeometry.scrollHeight - 1);
      expect(endGeometry.rowTop).toBeGreaterThanOrEqual(endGeometry.listTop);
      expect(endGeometry.rowBottom).toBeLessThanOrEqual(endGeometry.listBottom);
      const loadMoreControl = target.getByRole('button', {name: 'Load more groups'});
      await expect(loadMoreControl).toBeVisible();
      await loadMoreControl.scrollIntoViewIfNeeded();
      const restingLoadMore = await loadMoreControl.evaluate(control => {
        const style = getComputedStyle(control);
        const resolveColor = (color: string) => {
          const probe = document.createElement('span');
          probe.style.color = color;
          document.body.append(probe);
          const resolved = getComputedStyle(probe).color;
          probe.remove();
          return resolved;
        };
        return {
          background: style.backgroundColor,
          expectedSurface: resolveColor(style.getPropertyValue('--chat-surface-control').trim()),
          borderColor: style.borderTopColor,
          expectedBorder: resolveColor(style.getPropertyValue('--chat-line-strong').trim()),
          borderStyle: style.borderTopStyle,
          borderRadius: style.borderTopLeftRadius,
          height: control.getBoundingClientRect().height,
        };
      });
      expect(restingLoadMore.background, `${theme} Load more surface should use its theme control surface`).toBe(restingLoadMore.expectedSurface);
      expect(restingLoadMore.borderStyle).toBe('solid');
      expect(restingLoadMore.borderColor, `${theme} Load more border should use its theme control border`).toBe(restingLoadMore.expectedBorder);
      expect(parseFloat(restingLoadMore.borderRadius)).toBeGreaterThan(0);
      expect(restingLoadMore.height).toBeGreaterThanOrEqual(44);
      await loadMoreControl.focus();
      await target.keyboard.press('Tab');
      await target.keyboard.press('Shift+Tab');
      const focusedLoadMore = await loadMoreControl.evaluate(control => {
        const style = getComputedStyle(control);
        return {outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset};
      });
      expect(focusedLoadMore.outlineStyle).toBe('solid');
      expect(focusedLoadMore.outlineWidth).toBe('3px');
      expect(focusedLoadMore.outlineOffset).toBe('2px');
      await target.screenshot({path: testInfo.outputPath(`groups-first-page-${theme}-${width}x${height}-load-more-focused.png`)});
      await target.locator('body').click({position: {x: 4, y: 4}});
      const controlBounds = await loadMoreControl.boundingBox();
        const viewportHeight = target.viewportSize()?.height ?? 0;
        expect(controlBounds && controlBounds.x >= 0 && controlBounds.x + controlBounds.width <= width && controlBounds.y >= 0 && controlBounds.y + controlBounds.height <= viewportHeight).toBe(true);
        await target.screenshot({path: testInfo.outputPath(`groups-first-page-${theme}-${width}x${height}-end.png`)});
      }
    }
    await target.setViewportSize({width: 1440, height: 900});
    const currentLightTheme = await target.locator('html').evaluate(element => element.classList.contains('light-theme'));
    if (currentLightTheme) {
      await target.getByRole('button', {name: 'Account menu'}).click();
      await expectAccountMenuOverlayOpen(target);
      await target.getByRole('menuitem', {name: 'Switch to dark theme'}).click();
      await expectAccountMenuOverlayRemoved(target);
    }
    await target.locator('.people-list').evaluate(element => { element.scrollTop = element.scrollHeight; });
    const loadMore = target.getByRole('button', {name: 'Load more groups'});
    await expect(loadMore).toBeVisible();

    let failedCursorURL: string | undefined;
    let injectedFailures = 0;
    await target.route('**/api/chat/groups**', async route => {
      const requestURL = new URL(route.request().url());
      if (route.request().method() === 'GET' && requestURL.searchParams.has('cursor') && injectedFailures === 0) {
        failedCursorURL = requestURL.toString();
        injectedFailures++;
        await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'deterministic pagination failure'})});
        return;
      }
      await route.continue();
    });

    const firstPageIDsBeforeFailure = await target.locator('.person-option').evaluateAll(rows => rows.map(row => row.getAttribute('data-conversation-id')));
    expect(firstPageIDsBeforeFailure).toHaveLength(25);
    expect(new Set(firstPageIDsBeforeFailure).size).toBe(25);
    expect(firstPageIDsBeforeFailure).toEqual(firstPageIDs);
    const firstPageNamesBeforeFailure = await target.locator('.person-option strong').allTextContents();
    expect(firstPageNamesBeforeFailure).toEqual(renderedFirstPage.map(row => row.name));
    expect(firstPageNamesBeforeFailure).not.toContain('Group access needs verification');
    await loadMore.focus();
    const failedPageResponse = target.waitForResponse(response => response.url() === failedCursorURL && response.status() === 503);
    await target.keyboard.press('Enter');
    await failedPageResponse;
    expect(injectedFailures).toBe(1);
    expect(failedCursorURL).toBeDefined();
    const pageError = target.getByRole('alert').filter({hasText: 'Could not load more groups.'});
    await expect(pageError).toBeVisible();
    await expect(pageError.getByRole('button', {name: 'Retry'})).toBeEnabled();
    const firstPageIDsAfterFailure = await target.locator('.person-option').evaluateAll(rows => rows.map(row => row.getAttribute('data-conversation-id')));
    expect(firstPageIDsAfterFailure).toEqual(firstPageIDsBeforeFailure);
    expect(await target.locator('.person-option strong').allTextContents()).toEqual(firstPageNamesBeforeFailure);
    await target.mouse.click(700, 500);
    await expect(target.getByRole('menuitem', {name: 'Switch to light theme'})).toBeHidden();
    await expectAccountMenuOverlayRemoved(target);
    const retry = pageError.getByRole('button', {name: 'Retry'});
    for (const theme of ['dark', 'light'] as const) {
      for (const viewport of paginationViewports) {
        await target.setViewportSize(viewport);
        const isLightTheme = await target.locator('html').evaluate(element => element.classList.contains('light-theme'));
        if (isLightTheme !== (theme === 'light')) {
          await target.getByRole('button', {name: 'Account menu'}).click();
          await expectAccountMenuOverlayOpen(target);
          await target.getByRole('menuitem', {name: theme === 'light' ? 'Switch to light theme' : 'Switch to dark theme'}).click();
          await expectAccountMenuOverlayRemoved(target);
        }
        await expect(pageError).toBeVisible();
        await retry.focus();
        await target.keyboard.press('Tab');
        await target.keyboard.press('Shift+Tab');
        await expect(retry).toBeFocused();
        await expectGroupPageErrorAppearance(target, viewport.width);
        await expectAccountMenuOverlayRemoved(target);
        await target.screenshot({path: testInfo.outputPath(`groups-second-page-error-${theme}-${viewport.width}x${viewport.height}.png`)});
      }
    }

    await target.setViewportSize({width: 1440, height: 900});
    const beforeRetryLightTheme = await target.locator('html').evaluate(element => element.classList.contains('light-theme'));
    if (beforeRetryLightTheme) {
      await target.getByRole('button', {name: 'Account menu'}).click();
      await target.getByRole('menuitem', {name: 'Switch to dark theme'}).click();
      await expectAccountMenuOverlayRemoved(target);
    }

    const retriedPageResponse = target.waitForResponse(response => response.url() === failedCursorURL && response.status() === 200);
    await pageError.getByRole('button', {name: 'Retry'}).click();
    await retriedPageResponse;
    expect(injectedFailures).toBe(1);
    await expect(target.locator('.person-option')).toHaveCount(26, {timeout: 10_000});
    await expect(target.getByRole('button', {name: 'Load more groups'})).toHaveCount(0);
    await expect(target.locator('.groups-exhausted')).toHaveText('All groups loaded.');
    const allNames = await target.locator('.person-option strong').allTextContents();
    expect(allNames.sort()).toEqual(expectedNames);
    expect(new Set(allNames).size).toBe(26);
    const allIDs = await target.locator('.person-option').evaluateAll(rows => rows.map(row => row.getAttribute('data-conversation-id')));
    expect(new Set(allIDs).size).toBe(26);
    expect(allIDs.sort()).toEqual(expectedGroups.map(group => group.id).sort());

    for (const theme of ['dark', 'light'] as const) {
      for (const viewport of paginationViewports) {
        const {width, height} = viewport;
        await target.setViewportSize(viewport);
        const lightTheme = await target.locator('html').evaluate(element => element.classList.contains('light-theme'));
        if (lightTheme !== (theme === 'light')) {
          await target.getByRole('button', {name: 'Account menu'}).click();
          await target.getByRole('menuitem', {name: theme === 'light' ? 'Switch to light theme' : 'Switch to dark theme'}).click();
          await expectAccountMenuOverlayRemoved(target);
        }
        const list = target.locator('.people-list');
        await list.evaluate(element => { element.scrollTop = 0; });
        await expect(list.locator('.person-option').first()).toBeVisible();
        const railStart = await target.evaluate(() => ({documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, listWidth: document.querySelector<HTMLElement>('.people-list')?.clientWidth ?? 0, listScrollWidth: document.querySelector<HTMLElement>('.people-list')?.scrollWidth ?? 0}));
        expect(railStart.documentWidth).toBeLessThanOrEqual(railStart.viewportWidth);
        expect(railStart.listScrollWidth).toBeLessThanOrEqual(railStart.listWidth + 1);
        await target.screenshot({path: testInfo.outputPath(`groups-${theme}-${width}x${height}-top.png`)});
        await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await expect(list.locator('.person-option').last()).toBeVisible();
        const lastRow = await list.locator('.person-option').last().boundingBox();
        const rail = await list.boundingBox();
        expect(lastRow && rail && lastRow.x >= rail.x && lastRow.x + lastRow.width <= rail.x + rail.width).toBe(true);
        await target.screenshot({path: testInfo.outputPath(`groups-${theme}-${width}x${height}-end.png`)});
      }
    }
  } finally {
    await Promise.all([ownerOneContext.close(), ownerTwoContext.close(), targetContext.close()]);
  }
});
