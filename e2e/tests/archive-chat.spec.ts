import {expect, Page, test} from '@playwright/test';
import {fixtureToken, reloadSession} from './session-helpers';

const authBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const chatBase = process.env.CHAT_BASE_URL ?? 'https://chat.localhost';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';
const password = 'Password123!';
const desktop = {width: 1440, height: 900};
const wideDesktop = {width: 2560, height: 1440};
const compactDesktop = {width: 1024, height: 900};
const mobile = {width: 390, height: 844};
const viewports = [wideDesktop, desktop, compactDesktop, mobile];

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string): number => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Unsupported computed color: ${color}`);
    const linear = channels.map(channel => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

type Token = {access_token: string; token_type: string};

function uniqueEmail(name: string): string {
  return `e2e-archive-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
}

async function register(page: Page, email: string, nickname: string): Promise<void> {
  const adminToken = await fixtureToken(authBase, adminEmail, password, 'E2E');
  const invitation = await page.request.post(`${authBase}/api/admin/invitations`, {headers: {Authorization: `${adminToken.token_type} ${adminToken.access_token}`}, data: {email}});
  expect(invitation.status()).toBe(201);
  const {code} = await invitation.json() as {code: string};
  await page.goto(`/sign-up?invite=1&code=${encodeURIComponent(code)}`);
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="firstName"]').fill(nickname);
  await page.locator('[formControlName="lastName"]').fill('Archive');
  await page.locator('[formControlName="nickName"]').fill(nickname);
  await page.locator('[formControlName="password"]').fill(password);
  await page.locator('[formControlName="confirmPassword"]').fill(password);
  const response = page.waitForResponse(item => item.url().endsWith('/api/auth/v2/register') && item.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create account'}).click();
  expect((await response).status()).toBe(201);
  await expect(page).toHaveURL(/\/home$/);
}

async function loginToken(email: string): Promise<Token> {
  return fixtureToken(authBase, email, password, 'E2E');
}

async function userID(page: Page, token: Token, email: string): Promise<string> {
  const response = await page.request.get(`${chatBase}/api/chat/users/search?q=${encodeURIComponent(email)}`, {headers: {Authorization: `${token.token_type} ${token.access_token}`}});
  expect(response.status()).toBe(200);
  const result = (await response.json() as Array<{id: string; email: string}>).find(user => user.email === email);
  if (!result) throw new Error(`Could not resolve ${email}`);
  return result.id;
}

async function loadAllGroups(page: Page): Promise<void> {
  const loadMore = page.locator('.load-more-groups');
  const rows = page.locator('.conversation-row');
  await expect(rows.first()).toBeVisible();
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    if (await loadMore.count() === 0) return;
    const previousCount = await rows.count();
    if (await loadMore.isDisabled()) {
      await expect.poll(() => rows.count()).toBeGreaterThan(previousCount);
    } else {
      try {
        await loadMore.click();
      } catch (error) {
        if (await rows.count() <= previousCount) throw error;
      }
      await expect.poll(() => rows.count()).toBeGreaterThan(previousCount);
    }
  }
  await expect(loadMore).toHaveCount(0);
}

async function showAllChats(page: Page): Promise<void> {
  const activeTab = page.getByRole('button', {name: 'All chats'});
  if (await activeTab.getAttribute('aria-pressed') !== 'true') {
    const groupsResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/chat/groups' && url.searchParams.get('archived') !== 'true';
    });
    await activeTab.click();
    expect((await groupsResponse).status()).toBe(200);
  }
  await expect(activeTab).toHaveAttribute('aria-pressed', 'true');
  await loadAllGroups(page);
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const light = await page.locator('html').evaluate(node => node.classList.contains('light-theme'));
  if (light === (theme === 'light')) return;
  await page.getByRole('button', {name: 'Account menu'}).click();
  const themeOption = page.getByRole('menuitem', {name: theme === 'light' ? 'Switch to light theme' : 'Switch to dark theme'});
  await themeOption.click();
  await expect(page.locator('html')).toHaveClass(theme === 'light' ? /light-theme/ : /dark-theme/);
  // Escape also settles the menu if its label changed before its overlay finished closing.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
}

async function expectRailContained(page: Page, context: string, position: 'top' | 'end' = 'top'): Promise<void> {
  const geometry = await page.locator('.conversation-rail').evaluate(railElement => {
    const rail = railElement as HTMLElement;
    const bounds = rail.getBoundingClientRect();
    const list = rail.querySelector<HTMLElement>('.people-list');
    const listBounds = list?.getBoundingClientRect();
    const rows = Array.from(rail.querySelectorAll<HTMLElement>('.conversation-row'));
    const first = rows[0]?.getBoundingClientRect();
    const last = rows.at(-1)?.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
      rail: {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom},
      list: list && listBounds ? {left: listBounds.left, right: listBounds.right, top: listBounds.top, bottom: listBounds.bottom, scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, scrollWidth: list.scrollWidth, clientWidth: list.clientWidth} : undefined,
      rows: rows.map(row => {
        const button = row.querySelector<HTMLElement>('.person-option')?.getBoundingClientRect();
        const action = row.querySelector<HTMLElement>('.archive-chat-button')?.getBoundingClientRect();
        const bounds = row.getBoundingClientRect();
        const actionElement = row.querySelector<HTMLElement>('.archive-chat-button');
        return button && action ? {row: bounds.toJSON(), button: button.toJSON(), action: action.toJSON(), actionIconPath: actionElement?.querySelector('svg path')?.getAttribute('d'), fullyVisible: !!listBounds && bounds.top >= listBounds.top - 1 && bounds.bottom <= listBounds.bottom + 1, overlap: button.left < action.right && button.right > action.left && button.top < action.bottom && button.bottom > action.top} : undefined;
      }),
      rowCount: rows.length,
      firstVisible: !!first && !!listBounds && first.top >= listBounds.top - 1 && first.bottom <= listBounds.bottom + 1,
      lastVisible: !!last && !!listBounds && last.top >= listBounds.top - 1 && last.bottom <= listBounds.bottom + 1,
      scrolls: !!list && list.scrollHeight > list.clientHeight + 1,
    };
  });
  expect(geometry.documentWidth, `${context}: document horizontal overflow ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.rail.left, context).toBeGreaterThanOrEqual(-1);
  expect(geometry.rail.right, context).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  if (geometry.list) {
    expect(geometry.list.scrollWidth, `${context}: rail list horizontal overflow ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.list.clientWidth + 1);
    if (geometry.rowCount > 0) {
      expect(geometry.scrolls, `${context}: fixture must force actual vertical scrolling ${JSON.stringify(geometry)}`).toBe(true);
      if (position === 'top') expect(geometry.firstVisible, `${context}: first/top row not visible ${JSON.stringify(geometry)}`).toBe(true);
      else expect(geometry.lastVisible, `${context}: last/end row not visible ${JSON.stringify(geometry)}`).toBe(true);
    }
  }
  for (const row of geometry.rows) {
    expect(row, `${context}: missing archive row geometry`).toBeTruthy();
    expect(row!.overlap, `${context}: archive control overlaps conversation ${JSON.stringify(row)}`).toBe(false);
    expect(row!.action.width, `${context}: archive control width`).toBe(44);
    expect(row!.action.height, `${context}: archive control height`).toBe(44);
    expect(row!.actionIconPath, `${context}: archive action icon should render`).toBeTruthy();
    expect(row!.action.left, context).toBeGreaterThanOrEqual(geometry.rail.left - 1);
    expect(row!.action.right, context).toBeLessThanOrEqual(geometry.rail.right + 1);
    if (row!.fullyVisible && geometry.list) {
      expect(row!.action.top, context).toBeGreaterThanOrEqual(geometry.list.top - 1);
      expect(row!.action.bottom, context).toBeLessThanOrEqual(geometry.list.bottom + 1);
    }
  }
}

test('archive and explicitly restore direct and group chats per user; inbound messages stay archived', async ({browser}, testInfo) => {
  test.setTimeout(180_000);
  const aliceEmail = uniqueEmail('alice');
  const bobEmail = uniqueEmail('bob');
  const aliceContext = await browser.newContext({viewport: desktop});
  const bobContext = await browser.newContext({viewport: desktop});
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  // Keep individual browser actions bounded so a stalled page cannot consume
  // the whole long multi-user scenario timeout without identifying its step.
  alice.setDefaultTimeout(10_000);
  bob.setDefaultTimeout(10_000);
  let releaseArchiveResponse: () => void = () => {};
  let releaseRestoreResponse: () => void = () => {};

  try {
    await register(alice, aliceEmail, 'Alice Archive');
    await register(bob, bobEmail, 'Bob Archive');
    await Promise.all([expect(alice.locator('.conversation-rail')).toBeVisible(), expect(bob.locator('.conversation-rail')).toBeVisible()]);
    const aliceToken = await loginToken(aliceEmail);
    const bobID = await userID(alice, aliceToken, bobEmail);

    await expect(alice.getByRole('status').filter({hasText: 'No conversations yet.'})).toBeVisible();
    await expect(alice.locator('.rail-label')).toHaveCount(0);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(alice, theme);
      for (const viewport of viewports) {
        await alice.setViewportSize(viewport);
        await expect(alice.getByRole('status').filter({hasText: 'No conversations yet.'})).toBeVisible();
        await expectRailContained(alice, `${theme}/${viewport.width}x${viewport.height} empty All chats state`);
        await alice.screenshot({path: testInfo.outputPath(`archive-empty-all-chats-${theme}-${viewport.width}x${viewport.height}.png`)});
      }
    }
    await alice.setViewportSize(desktop);
    let releaseArchivedGroups!: () => void;
    let archivedGroupsRequested!: () => void;
    const archivedGroupsGate = new Promise<void>(resolve => { releaseArchivedGroups = resolve; });
    const archivedGroupsSeen = new Promise<void>(resolve => { archivedGroupsRequested = resolve; });
    await alice.route('**/api/chat/groups?**', async route => {
      if (new URL(route.request().url()).searchParams.get('archived') !== 'true') return route.continue();
      archivedGroupsRequested();
      await archivedGroupsGate;
      await route.continue();
    });
    await alice.getByRole('button', {name: 'Archived'}).click();
    await archivedGroupsSeen;
    await expect(alice.getByRole('status').filter({hasText: 'Loading archived chats…'})).toBeVisible();
    releaseArchivedGroups();
    await expect(alice.getByRole('status').filter({hasText: 'No archived chats.'})).toBeVisible();
    await alice.unroute('**/api/chat/groups?**');
    await alice.getByRole('button', {name: 'All chats'}).click();

    const groupResponse = await alice.request.post(`${chatBase}/api/chat/groups`, {headers: {Authorization: `${aliceToken.token_type} ${aliceToken.access_token}`}, data: {name: 'Archive Crew', member_ids: [bobID]}});
    expect(groupResponse.status()).toBe(201);
    const group = await groupResponse.json() as {id: string; name: string};
    const bobToken = await loginToken(bobEmail);
    const aliceID = await userID(bob, bobToken, aliceEmail);
    const createScrollGroup = async (index: number, owner: 'alice' | 'bob') => {
      const name = `Archive Scroll Group ${String(index + 1).padStart(2, '0')}`;
      const asAlice = owner === 'alice';
      const response = await (asAlice ? alice : bob).request.post(`${chatBase}/api/chat/groups`, {
        headers: {Authorization: `${asAlice ? aliceToken.token_type : bobToken.token_type} ${asAlice ? aliceToken.access_token : bobToken.access_token}`},
        data: {name, member_ids: [asAlice ? bobID : aliceID]},
      });
      expect(response.status(), `creating ${name}`).toBe(201);
      return await response.json() as {id: string; name: string};
    };
    // Split creation across both users to stay within the per-user mutation limit.
    const additionalGroups = await Promise.all([
      ...Array.from({length: 18}, (_, index) => createScrollGroup(index, 'alice')),
      ...Array.from({length: 20}, (_, index) => createScrollGroup(index + 18, 'bob')),
    ]);
    await reloadSession(alice);
    await loadAllGroups(alice);
    await expect(alice.locator('.conversation-row')).toHaveCount(39);

    await alice.getByPlaceholder('Name or email').fill(bobEmail);
    await alice.getByRole('button', {name: 'Start a conversation with Bob Archive'}).click();
    await expect(alice.locator('.chat-header h2')).toHaveText('Bob Archive');
    const directMessage = 'Alice confirms Bob receives this message';
    await alice.getByRole('textbox', {name: 'Message'}).fill(directMessage);
    await alice.getByRole('button', {name: 'Send message'}).click();
    await expect(alice.locator('.message-list')).toContainText(directMessage);
    await reloadSession(bob);
    await expect(bob.locator('.person-option[aria-label="Alice Archive"]')).toBeVisible();
    await bob.locator('.person-option[aria-label="Alice Archive"]').click();
    await expect(bob.locator('.message-list')).toContainText(directMessage);

    // The peer's group membership is established before Alice changes only her presentation state.
    await reloadSession(bob);
    await loadAllGroups(bob);
    await expect(bob.locator(`.person-option[data-conversation-id="${group.id}"]`)).toBeVisible();

    let failArchive = true;
    let holdArchive = false;
    let signalArchiveStarted: () => void = () => {};
    let archiveRequestStarted = new Promise<void>(resolve => { signalArchiveStarted = resolve; });
    let archiveResponseGate = new Promise<void>(resolve => { releaseArchiveResponse = resolve; });
    let archiveMutationRequests = 0;
    const archiveRoute = async (route: import('@playwright/test').Route): Promise<void> => {
      if (route.request().method() === 'PUT') archiveMutationRequests += 1;
      if (failArchive && route.request().method() === 'PUT') await route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({error: 'injected archive failure'})});
      else if (holdArchive && route.request().method() === 'PUT') {
        holdArchive = false;
        signalArchiveStarted();
        await archiveResponseGate;
        await route.continue();
      }
      else await route.continue();
    };
    await alice.route('**/api/chat/conversations/*/archive', archiveRoute);
    await alice.getByRole('button', {name: 'Archive Bob Archive'}).click();
    await expect(alice.getByRole('alert').filter({hasText: 'Could not archive this chat. It is still in your list.'})).toBeVisible();
    await expect(alice.locator('.person-option[aria-label="Bob Archive"]')).toBeVisible();
    await expect(alice.locator('.person-option[aria-label="Bob Archive"]')).toHaveClass(/selected/);
    await expect(alice.locator('.chat-header h2')).toHaveText('Bob Archive');
    await expect(alice.getByRole('button', {name: 'Archive Bob Archive'})).toBeFocused();
    await alice.screenshot({path: testInfo.outputPath('archive-selected-row-error-dark-1440.png')});
    failArchive = false;
    holdArchive = true;
    archiveRequestStarted = new Promise<void>(resolve => { signalArchiveStarted = resolve; });
    archiveResponseGate = new Promise<void>(resolve => { releaseArchiveResponse = resolve; });
    const archiveDirectResponse = alice.waitForResponse(response => response.request().method() === 'PUT' && /\/api\/chat\/conversations\/[^/]+\/archive$/.test(response.url()), {timeout: 15_000}).catch(() => undefined);
    await alice.getByRole('button', {name: 'Archive Bob Archive'}).click();
    await archiveRequestStarted;
    const pendingArchive = alice.getByRole('button', {name: 'Archiving Bob Archive'});
    await expect(pendingArchive).toHaveAttribute('aria-disabled', 'true');
    await expect(pendingArchive).toHaveAttribute('aria-busy', 'true');
    await expect(pendingArchive).toBeFocused();
    await expect(pendingArchive.locator('svg path')).toHaveAttribute('d', /M6 2v6/);
    await expect(alice.locator('.mat-mdc-tooltip')).toBeHidden();
    const requestsWhilePending = archiveMutationRequests;
    const duplicateArchiveRequest = alice.waitForRequest(request => request.method() === 'PUT' && /\/api\/chat\/conversations\/[^/]+\/archive$/.test(request.url()), {timeout: 300}).then(() => true, () => false);
    const pendingArchiveBounds = await pendingArchive.boundingBox();
    expect(pendingArchiveBounds, 'pending archive action should remain visible').toBeTruthy();
    await alice.mouse.click(pendingArchiveBounds!.x + pendingArchiveBounds!.width / 2, pendingArchiveBounds!.y + pendingArchiveBounds!.height / 2);
    expect(await duplicateArchiveRequest, 'a pending archive action must not issue a duplicate request').toBe(false);
    expect(archiveMutationRequests).toBe(requestsWhilePending);
    await expect(alice.locator('.archive-chat-button:not([aria-disabled="true"])').first()).toBeVisible();
    await alice.screenshot({path: testInfo.outputPath('archive-pending-dark-1440.png')});
    releaseArchiveResponse();
    const archivedResponse = await archiveDirectResponse;
    expect(archivedResponse?.status(), 'archiving the selected direct conversation must be accepted').toBe(204);
    await alice.unroute('**/api/chat/conversations/*/archive', archiveRoute);
    await expect(alice.locator('.person-option[aria-label="Bob Archive"]')).toHaveCount(0);
    await expect(alice.locator('.chat-header h2')).toHaveText('Choose a conversation');
    await expect(alice.locator('.message-history')).toHaveCount(0);
    await expect(alice.locator('.chat-empty')).toBeVisible();
    await expect(bob.locator('.person-option[aria-label="Alice Archive"]')).toBeVisible();

    await alice.getByRole('button', {name: 'Archived'}).click();
    await expect(alice.locator('.person-option[aria-label="Bob Archive"]')).toBeVisible();
    await expect(alice.locator(`.person-option[data-conversation-id="${group.id}"]`)).toHaveCount(0);
    let failRestore = true;
    let holdRestore = false;
    let signalRestoreStarted: () => void = () => {};
    let restoreRequestStarted = new Promise<void>(resolve => { signalRestoreStarted = resolve; });
    let restoreResponseGate = new Promise<void>(resolve => { releaseRestoreResponse = resolve; });
    let restoreMutationRequests = 0;
    const restoreRoute = async (route: import('@playwright/test').Route): Promise<void> => {
      if (route.request().method() === 'DELETE') restoreMutationRequests += 1;
      if (failRestore && route.request().method() === 'DELETE') await route.fulfill({status: 500, contentType: 'application/json', body: JSON.stringify({error: 'injected restore failure'})});
      else if (holdRestore && route.request().method() === 'DELETE') {
        holdRestore = false;
        signalRestoreStarted();
        await restoreResponseGate;
        await route.continue();
      }
      else await route.continue();
    };
    await alice.route('**/api/chat/conversations/*/archive', restoreRoute);
    await alice.locator('.person-option[aria-label="Bob Archive"]').click();
    await alice.getByRole('button', {name: 'Restore Bob Archive'}).click();
    await expect(alice.getByRole('alert').filter({hasText: 'Could not restore this chat. It is still in your list.'})).toBeVisible();
    await expect(alice.locator('.person-option[aria-label="Bob Archive"]')).toBeVisible();
    await expect(alice.locator('.person-option[aria-label="Bob Archive"]')).toHaveClass(/selected/);
    await expect(alice.locator('.chat-header h2')).toHaveText('Bob Archive');
    failRestore = false;
    holdRestore = true;
    restoreRequestStarted = new Promise<void>(resolve => { signalRestoreStarted = resolve; });
    restoreResponseGate = new Promise<void>(resolve => { releaseRestoreResponse = resolve; });
    const restoreDirectResponse = alice.waitForResponse(response => response.request().method() === 'DELETE' && /\/api\/chat\/conversations\/[^/]+\/archive$/.test(response.url()), {timeout: 15_000}).catch(() => undefined);
    await alice.getByRole('button', {name: 'Restore Bob Archive'}).click();
    await restoreRequestStarted;
    const pendingRestore = alice.getByRole('button', {name: 'Restoring Bob Archive'});
    await expect(pendingRestore).toHaveAttribute('aria-disabled', 'true');
    await expect(pendingRestore).toHaveAttribute('aria-busy', 'true');
    await expect(pendingRestore).toBeFocused();
    await expect(pendingRestore.locator('svg path')).toHaveAttribute('d', /M6 2v6/);
    await expect(alice.locator('.mat-mdc-tooltip')).toBeHidden();
    const restoresWhilePending = restoreMutationRequests;
    const duplicateRestoreRequest = alice.waitForRequest(request => request.method() === 'DELETE' && /\/api\/chat\/conversations\/[^/]+\/archive$/.test(request.url()), {timeout: 300}).then(() => true, () => false);
    const pendingRestoreBounds = await pendingRestore.boundingBox();
    expect(pendingRestoreBounds, 'pending restore action should remain visible').toBeTruthy();
    await alice.mouse.click(pendingRestoreBounds!.x + pendingRestoreBounds!.width / 2, pendingRestoreBounds!.y + pendingRestoreBounds!.height / 2);
    expect(await duplicateRestoreRequest, 'a pending restore action must not issue a duplicate request').toBe(false);
    expect(restoreMutationRequests).toBe(restoresWhilePending);
    await alice.screenshot({path: testInfo.outputPath('restore-pending-dark-1440.png')});
    releaseRestoreResponse();
    const restoredResponse = await restoreDirectResponse;
    expect(restoredResponse?.status(), 'restoring the selected direct conversation must be accepted').toBe(204);
    await expect(alice.locator('.person-option[aria-label="Bob Archive"]')).toHaveCount(0);
    await alice.unroute('**/api/chat/conversations/*/archive', restoreRoute);

    // Group archive and explicit restore are also private to Alice.
    await showAllChats(alice);
    await expect(alice.locator('.person-option[aria-label="Bob Archive"]')).toBeVisible();
    await expect(alice.getByRole('button', {name: 'Restore Bob Archive'})).toHaveCount(0);
    const groupRow = alice.locator(`.conversation-row:has(.person-option[data-conversation-id="${group.id}"])`);
    await expect(groupRow.getByRole('button', {name: 'Archive Archive Crew'})).toBeVisible();
    await groupRow.getByRole('button', {name: 'Archive Archive Crew'}).click();
    await expect(alice.locator(`.person-option[data-conversation-id="${group.id}"]`)).toHaveCount(0);
    await reloadSession(bob);
    await loadAllGroups(bob);
    await expect(bob.locator(`.person-option[data-conversation-id="${group.id}"]`)).toBeVisible();
    await alice.getByRole('button', {name: 'Archived'}).click();
    const archivedGroup = alice.locator(`.conversation-row:has(.person-option[data-conversation-id="${group.id}"])`);
    await expect(archivedGroup.getByRole('button', {name: 'Restore Archive Crew'})).toBeVisible();
    await archivedGroup.getByRole('button', {name: 'Restore Archive Crew'}).click();
    await expect(alice.locator(`.person-option[data-conversation-id="${group.id}"]`)).toHaveCount(0);
    await showAllChats(alice);
    await expect(alice.locator(`.person-option[data-conversation-id="${group.id}"]`)).toBeVisible();

    // Archive Alice's direct conversation again; Bob sends a new inbound message while it is archived.
    await alice.locator('.person-option[aria-label="Bob Archive"]').click();
    await expect(alice.locator('.chat-header h2')).toHaveText('Bob Archive');
    await alice.getByRole('button', {name: 'Archive Bob Archive'}).click();
    await expect(alice.locator('.chat-header h2')).toHaveText('Choose a conversation');
    await expect(alice.locator('.message-history')).toHaveCount(0);
    await bob.locator('.person-option[aria-label="Alice Archive"]').click();
    const inbound = 'Bob sent this after Alice archived the conversation';
    await bob.getByRole('textbox', {name: 'Message'}).fill(inbound);
    await bob.getByRole('button', {name: 'Send message'}).click();
    await expect(bob.locator('.message-list')).toContainText(inbound);
    await alice.getByRole('button', {name: 'Archived'}).click();
    const archivedDirect = alice.locator('.person-option[aria-label="Bob Archive"]');
    await expect(archivedDirect).toBeVisible();
    await archivedDirect.click();
    await expect(alice.locator('.message-list')).toContainText(inbound);
    await expect(alice.locator('.person-option[aria-label="Bob Archive"]')).toBeVisible();
    await expect(alice.getByRole('button', {name: 'Restore Bob Archive'})).toBeVisible();

    // Populate both list surfaces with enough named group rows to force scrolling.
    await showAllChats(alice);
    await alice.locator(`.conversation-row:has(.person-option[data-conversation-id="${group.id}"])`).getByRole('button', {name: 'Archive Archive Crew'}).click();
    for (const archivedGroup of additionalGroups.slice(18, 36)) {
      const row = alice.locator(`.conversation-row:has(.person-option[aria-label="${archivedGroup.name}"])`);
      await row.getByRole('button', {name: `Archive ${archivedGroup.name}`}).click();
    }
    await expect(alice.locator(`.person-option[data-conversation-id="${group.id}"]`)).toHaveCount(0);
    await alice.getByRole('button', {name: 'Archived'}).click();
    await expect(alice.locator(`.person-option[data-conversation-id="${group.id}"]`)).toBeVisible();

    // Authenticated group-list requests preserve the page envelope and treat an
    // omitted or explicitly false archived flag as the active list.
    const authHeaders = {Authorization: `${aliceToken.token_type} ${aliceToken.access_token}`};
    const listGroups = async (query: string) => {
      const response = await alice.request.get(`${chatBase}/api/chat/groups${query}`, {headers: authHeaders});
      expect(response.status()).toBe(200);
      const body = await response.json() as {items: Array<{id: string; name: string}>; next_cursor: string | null};
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.next_cursor === null || typeof body.next_cursor === 'string').toBe(true);
      return body;
    };
    const [activeOmitted, activeFalse, archivedItems] = await Promise.all([
      listGroups('?limit=25'), listGroups('?limit=25&archived=false'), listGroups('?limit=25&archived=true'),
    ]);
    expect(activeOmitted).toEqual(activeFalse);
    expect(activeOmitted.items.some(item => item.id === additionalGroups[0].id)).toBe(true);
    expect(activeOmitted.items.some(item => item.id === additionalGroups[18].id)).toBe(false);
    expect(archivedItems.items.some(item => item.id === additionalGroups[18].id)).toBe(true);
    expect(archivedItems.items.some(item => item.id === additionalGroups[0].id)).toBe(false);

    // Capture populated active and archived list surfaces in both themes and all viewports.
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(alice, theme);
      for (const viewport of viewports) {
        await alice.setViewportSize(viewport);
        for (const surface of ['active', 'archived'] as const) {
          if (surface === 'active') {
            await showAllChats(alice);
          }
          else await alice.getByRole('button', {name: 'Archived'}).click();
          const state = `${theme}/${viewport.width}x${viewport.height} ${surface} conversations`;
          const list = alice.locator('.people-list');
          await expect(list.locator('.conversation-row').first()).toBeVisible();
          await list.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
          await expectRailContained(alice, state, 'top');
          const actionVerb = surface === 'active' ? 'Archive' : 'Restore';
          const actionTooltip = surface === 'active' ? 'Archive chat' : 'Restore chat';
          const firstRow = list.locator('.conversation-row').first();
          const conversationLabel = await firstRow.locator('.person-option').getAttribute('aria-label');
          expect(conversationLabel, `${state}: conversation needs an accessible name`).toBeTruthy();
          const action = firstRow.getByRole('button', {name: `${actionVerb} ${conversationLabel}`});
          await expect(action).toBeVisible();
          await expect(action).not.toHaveAttribute('aria-busy');
          await expect(action.locator('svg path')).toBeVisible();
          expect(await action.locator('svg path').getAttribute('d')).toContain(surface === 'active' ? 'M20.54 5.23' : 'M4 11h16v9');
          const iconContrast = await action.evaluate(element => {
            const rail = element.closest('.conversation-rail');
            return {foreground: getComputedStyle(element).color, background: rail ? getComputedStyle(rail).backgroundColor : ''};
          });
          expect(contrastRatio(iconContrast.foreground, iconContrast.background), `${state}: icon contrast ${JSON.stringify(iconContrast)}`).toBeGreaterThanOrEqual(3);
          await action.hover();
          const tooltip = alice.locator('.mat-mdc-tooltip');
          await expect(tooltip).toHaveText(actionTooltip);
          const tooltipBounds = await tooltip.boundingBox();
          expect(tooltipBounds, `${state}: tooltip must be rendered`).toBeTruthy();
          const tooltipOverlap = await tooltip.evaluate(element => {
            const tooltipRect = element.getBoundingClientRect();
            const intersects = (target: Element | null): boolean => {
              if (!target) return false;
              const targetRect = target.getBoundingClientRect();
              return tooltipRect.left < targetRect.right && tooltipRect.right > targetRect.left && tooltipRect.top < targetRect.bottom && tooltipRect.bottom > targetRect.top;
            };
            const modeTabs = document.querySelector('.archive-mode-tabs');
            const topRow = document.querySelector('.people-list .conversation-row');
            const rowContent = topRow ? Array.from(topRow.querySelectorAll<HTMLElement>('.person-avatar, .conversation-copy, .conversation-time, .unread-count')) : [];
            return {
              hasModeTabs: !!modeTabs,
              hasTopRow: !!topRow,
              rowContent: rowContent.map(target => ({className: target.className, overlaps: intersects(target), bounds: target.getBoundingClientRect().toJSON()})),
            };
          });
          expect(tooltipOverlap.hasModeTabs, `${state}: chat mode tabs should be present for overlap check`).toBe(true);
          expect(tooltipOverlap.hasTopRow, `${state}: first conversation row should be present for overlap check`).toBe(true);
          expect(tooltipOverlap.rowContent.length, `${state}: first conversation row should have visible content to check`).toBeGreaterThan(0);
          expect(tooltipOverlap.rowContent.filter(target => target.overlaps), `${state}: tooltip must not obscure visible first-row content ${JSON.stringify(tooltipOverlap.rowContent)}`).toHaveLength(0);
          expect(tooltipBounds!.x, `${state}: tooltip must stay inside viewport`).toBeGreaterThanOrEqual(0);
          expect(tooltipBounds!.x + tooltipBounds!.width, `${state}: tooltip must stay inside viewport`).toBeLessThanOrEqual(viewport.width + 1);
          expect(tooltipBounds!.y, `${state}: tooltip must stay inside viewport`).toBeGreaterThanOrEqual(0);
          expect(tooltipBounds!.y + tooltipBounds!.height, `${state}: tooltip must stay inside viewport`).toBeLessThanOrEqual(viewport.height + 1);
          await alice.screenshot({path: testInfo.outputPath(`archive-${surface}-${theme}-${viewport.width}x${viewport.height}-action-tooltip.png`)});
          await alice.mouse.move(0, 0);
          await expect(tooltip).toBeHidden();
          {
            const modeTab = alice.getByRole('button', {name: surface === 'active' ? 'All chats' : 'Archived'});
            await modeTab.focus();
            let reachedAction = await action.evaluate(element => document.activeElement === element);
            const tabStops = (await list.locator('.conversation-row').count()) * 2 + 2;
            for (let step = 0; step < tabStops && !reachedAction; step++) {
              await alice.keyboard.press('Tab');
              reachedAction = await action.evaluate(element => document.activeElement === element);
            }
            const focus = await action.evaluate(element => {
              const rect = element.getBoundingClientRect();
              const railElement = element.closest('.conversation-rail');
              const rail = railElement?.getBoundingClientRect();
              const list = element.closest<HTMLElement>('.people-list');
              const scrollport = list?.getBoundingClientRect();
              const expansion = Number.parseFloat(getComputedStyle(element).outlineWidth) + Number.parseFloat(getComputedStyle(element).outlineOffset);
              return {
                active: document.activeElement === element,
                outlineStyle: getComputedStyle(element).outlineStyle,
                outlineWidth: getComputedStyle(element).outlineWidth,
                outlineColor: getComputedStyle(element).outlineColor,
                railBackground: railElement ? getComputedStyle(railElement).backgroundColor : '',
                listScrollTop: list?.scrollTop,
                outlineBounds: {left: rect.left - expansion, right: rect.right + expansion, top: rect.top - expansion, bottom: rect.bottom + expansion},
                railBounds: rail ? {left: rail.left, right: rail.right, top: rail.top, bottom: rail.bottom} : undefined,
                scrollportBounds: scrollport ? {left: scrollport.left, right: scrollport.right, top: scrollport.top, bottom: scrollport.bottom} : undefined,
              };
            });
            expect(reachedAction && focus.active, `${state}: keyboard navigation should reach ${actionVerb} icon`).toBe(true);
            expect(focus.outlineStyle, `${state}: keyboard focus outline style`).not.toBe('none');
            expect(Number.parseFloat(focus.outlineWidth), `${state}: keyboard focus outline width`).toBeGreaterThan(0);
            expect(contrastRatio(focus.outlineColor, focus.railBackground), `${state}: keyboard focus indicator contrast`).toBeGreaterThanOrEqual(3);
            expect(focus.outlineBounds.left, `${state}: focus outline left containment`).toBeGreaterThanOrEqual(0);
            expect(focus.outlineBounds.right, `${state}: focus outline right containment`).toBeLessThanOrEqual(viewport.width);
            expect(focus.outlineBounds.top, `${state}: focus outline top containment`).toBeGreaterThanOrEqual(0);
            expect(focus.outlineBounds.bottom, `${state}: focus outline bottom containment`).toBeLessThanOrEqual(viewport.height);
            expect(focus.outlineBounds.left, `${state}: focus outline left containment in rail`).toBeGreaterThanOrEqual(focus.railBounds!.left - 1);
            expect(focus.outlineBounds.right, `${state}: focus outline right containment in rail`).toBeLessThanOrEqual(focus.railBounds!.right + 1);
            expect(focus.outlineBounds.top, `${state}: focus outline top containment in rail`).toBeGreaterThanOrEqual(focus.railBounds!.top - 1);
            expect(focus.outlineBounds.bottom, `${state}: focus outline bottom containment in rail`).toBeLessThanOrEqual(focus.railBounds!.bottom + 1);
            expect(focus.outlineBounds.left, `${state}: focus outline left containment in scrollport`).toBeGreaterThanOrEqual(focus.scrollportBounds!.left - 1);
            expect(focus.outlineBounds.right, `${state}: focus outline right containment in scrollport`).toBeLessThanOrEqual(focus.scrollportBounds!.right + 1);
            expect(focus.outlineBounds.top, `${state}: focus outline top containment in scrollport`).toBeGreaterThanOrEqual(focus.scrollportBounds!.top - 1);
            expect(focus.outlineBounds.bottom, `${state}: focus outline bottom containment in scrollport`).toBeLessThanOrEqual(focus.scrollportBounds!.bottom + 1);
            expect(focus.listScrollTop, `${state}: focus test should start at list top`).toBe(0);
            await expect(tooltip).toBeVisible();
            await expect(tooltip).toHaveText(actionTooltip);
            await alice.screenshot({path: testInfo.outputPath(`archive-${surface}-${theme}-${viewport.width}x${viewport.height}-action-keyboard-focus.png`)});
            await action.evaluate(element => element.blur());
            await expect(tooltip).toBeHidden();
            await list.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
          }
          await alice.screenshot({path: testInfo.outputPath(`archive-${surface}-${theme}-${viewport.width}x${viewport.height}-top.png`)});
          await list.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
          await expect.poll(() => list.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1)).toBe(true);
          await expectRailContained(alice, `${state} list end`, 'end');
          await alice.screenshot({path: testInfo.outputPath(`archive-${surface}-${theme}-${viewport.width}x${viewport.height}-end.png`)});
        }
      }
    }

    await alice.getByRole('button', {name: 'Archived'}).click();
    await alice.getByRole('button', {name: 'Restore Bob Archive'}).click();
    await alice.getByRole('button', {name: 'Restore Archive Crew'}).click();
    // These archived scroll-fixture groups belong to Bob. Remove the fixtures
    // as their owner so Alice's archive stays scoped to Alice and her empty-state
    // capture does not consume Alice's per-user mutation quota.
    for (const archivedGroup of additionalGroups.slice(18, 36)) {
      const response = await bob.request.delete(`${chatBase}/api/chat/groups/${archivedGroup.id}`, {headers: {Authorization: `${bobToken.token_type} ${bobToken.access_token}`}});
      expect(response.status(), `deleting fixture ${archivedGroup.name}`).toBe(204);
    }
    await reloadSession(alice);
    await alice.getByRole('button', {name: 'Archived'}).click();
    await expect(alice.getByRole('status').filter({hasText: 'No archived chats.'})).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(alice, theme);
      for (const viewport of viewports) {
        await alice.setViewportSize(viewport);
        await expect(alice.getByRole('status').filter({hasText: 'No archived chats.'})).toBeVisible();
        await expectRailContained(alice, `${theme}/${viewport.width}x${viewport.height} empty Archived state`);
        await alice.screenshot({path: testInfo.outputPath(`archive-empty-${theme}-${viewport.width}x${viewport.height}.png`)});
      }
    }

    // Leave an archived row visible while signing out, then verify /home stays private anonymously.
    await showAllChats(alice);
    await alice.locator(`.conversation-row:has(.person-option[data-conversation-id="${group.id}"])`).getByRole('button', {name: 'Archive Archive Crew'}).click();
    await alice.getByRole('button', {name: 'Archived'}).click();
    await expect(alice.locator(`.person-option[data-conversation-id="${group.id}"]`)).toBeVisible();
    await alice.getByRole('button', {name: 'Account menu'}).click();
    await alice.getByRole('menuitem', {name: 'Sign out'}).click();
    await expect(alice).toHaveURL(/\/login$/);
    await expect(alice.locator('.conversation-rail')).toHaveCount(0);
    await expect(alice.locator('body')).not.toContainText('Archive Crew');
    expect(await alice.evaluate(() => localStorage.getItem('zwei.intended-session'))).toBeNull();
    const refreshRequests: string[] = [];
    alice.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/v2/refresh') refreshRequests.push(request.method()); });
    await alice.goto('/home');
    await expect(alice).toHaveURL(/\/login$/);
    expect(refreshRequests).toEqual([]);
    await expect(alice.locator('.conversation-rail')).toHaveCount(0);
    await expect(alice.locator('body')).not.toContainText('Archive Crew');
  } finally {
    releaseArchiveResponse();
    releaseRestoreResponse();
    await aliceContext.close();
    await bobContext.close();
  }
});
