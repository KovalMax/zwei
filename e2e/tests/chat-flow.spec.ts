import { expect, Locator, Page, test } from '@playwright/test';

const password = 'Password123!';
const adminBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const chatBase = process.env.CHAT_BASE_URL ?? 'https://chat.localhost';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';

function uniqueEmail(name: string): string {
  return `e2e-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
}

type BrowserNotificationRecord = {title: string; body?: string; tag?: string};
type RenderedContrast = {foreground: string; background: string; ratio: number};
type RenderedTextContrast = {foreground: string; background: string; ratio: number; opacity: number; disabled: boolean};

async function waitForTooltipAnimation(tooltip: Locator): Promise<void> {
  await tooltip.evaluate(async element => {
    const panel = element.closest<HTMLElement>('.mat-mdc-tooltip-panel') ?? element;
    await Promise.all(panel.getAnimations({subtree: true}).map(animation => animation.finished.catch(() => undefined)));
  });
}

async function measureRenderedTextContrast(element: Locator): Promise<RenderedContrast> {
  return element.evaluate(node => {
    type RGBA = readonly [number, number, number, number];
    const parse = (color: string): RGBA => {
      const channels = color.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length < 3) throw new Error(`Unexpected computed color: ${color}`);
      return [channels[0], channels[1], channels[2], channels[3] ?? 1];
    };
    const composite = (top: RGBA, bottom: RGBA): RGBA => {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / alpha,
        (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / alpha,
        (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / alpha,
        alpha,
      ];
    };
    const luminance = (color: RGBA): number => color.slice(0, 3).map(channel => channel / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const style = getComputedStyle(node);
    let background = parse(style.backgroundColor);
    let ancestor = node.parentElement;
    while (background[3] < .999 && ancestor) {
      background = composite(background, parse(getComputedStyle(ancestor).backgroundColor));
      ancestor = ancestor.parentElement;
    }
    const foregroundColor = style.color;
    const foreground = parse(foregroundColor);
    const opacity = Number.parseFloat(style.opacity);
    const effectiveOpacity = foreground[3] * (Number.isFinite(opacity) ? opacity : 1);
    const renderedForeground = composite([foreground[0], foreground[1], foreground[2], effectiveOpacity], background);
    const foregroundLuminance = luminance(renderedForeground);
    const backgroundLuminance = luminance(background);
    return {
      foreground: foregroundColor,
      background: `rgba(${background[0]}, ${background[1]}, ${background[2]}, ${background[3]})`,
      ratio: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05),
    };
  });
}

async function measureRenderedTextContrastAtSurface(element: Locator, pseudoElement?: '::placeholder'): Promise<RenderedTextContrast> {
  return element.evaluate((node, pseudo) => {
    type RGBA = readonly [number, number, number, number];
    const parse = (color: string): RGBA => {
      const channels = color.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length < 3) throw new Error(`Unexpected computed color: ${color}`);
      return [channels[0], channels[1], channels[2], channels[3] ?? 1];
    };
    const composite = (top: RGBA, bottom: RGBA): RGBA => {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / alpha,
        (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / alpha,
        (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / alpha,
        alpha,
      ];
    };
    const luminance = (color: RGBA): number => color.slice(0, 3).map(channel => channel / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const ancestry: Element[] = [];
    for (let current: Element | null = node; current; current = current.parentElement) ancestry.push(current);
    const backgroundAnchorIndex = ancestry.findIndex(ancestor => parse(getComputedStyle(ancestor).backgroundColor)[3] > 0);
    const safeAnchorIndex = backgroundAnchorIndex >= 0 ? backgroundAnchorIndex : ancestry.length - 1;
    const anchor = ancestry[safeAnchorIndex];
    const anchorStyle = getComputedStyle(anchor);
    const anchorColor = parse(anchorStyle.backgroundColor);
    const backdropLayers = ancestry.slice(safeAnchorIndex + 1).reverse();
    let backdrop: RGBA = [255, 255, 255, 1];
    for (const layer of backdropLayers) {
      const style = getComputedStyle(layer);
      const color = parse(style.backgroundColor);
      const opacity = Number.parseFloat(style.opacity);
      backdrop = composite([color[0], color[1], color[2], color[3] * (Number.isFinite(opacity) ? opacity : 1)], backdrop);
    }
    let backgroundOpacity = 1;
    for (const layer of ancestry.slice(0, safeAnchorIndex + 1)) {
      const opacity = Number.parseFloat(getComputedStyle(layer).opacity);
      backgroundOpacity *= Number.isFinite(opacity) ? opacity : 1;
    }
    const background = composite([anchorColor[0], anchorColor[1], anchorColor[2], anchorColor[3] * backgroundOpacity], backdrop);
    const textStyle = getComputedStyle(node, pseudo || null);
    const foregroundColor = textStyle.color;
    const foreground = parse(foregroundColor);
    const pseudoOpacity = Number.parseFloat(textStyle.opacity);
    let foregroundOpacity = foreground[3] * (Number.isFinite(pseudoOpacity) ? pseudoOpacity : 1);
    for (const layer of ancestry) {
      const opacity = Number.parseFloat(getComputedStyle(layer).opacity);
      foregroundOpacity *= Number.isFinite(opacity) ? opacity : 1;
    }
    const renderedForeground = composite([foreground[0], foreground[1], foreground[2], foregroundOpacity], background);
    const foregroundLuminance = luminance(renderedForeground);
    const backgroundLuminance = luminance(background);
    return {
      foreground: foregroundColor,
      background: `rgba(${background[0]}, ${background[1]}, ${background[2]}, ${background[3]})`,
      ratio: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05),
      opacity: pseudoOpacity,
      disabled: 'disabled' in node && Boolean((node as HTMLInputElement).disabled),
    };
  }, pseudoElement);
}

function observePresenceSnapshots(page: Page): string[][] {
  const snapshots: string[][] = [];
  page.on('websocket', socket => {
    socket.on('framereceived', frame => {
      if (typeof frame.payload !== 'string') return;
      try {
        const event: unknown = JSON.parse(frame.payload);
        if (typeof event !== 'object' || event === null || !('type' in event) || !('payload' in event)) return;
        const payload = event.payload;
        if (event.type !== 'presence.snapshot' || typeof payload !== 'object' || payload === null || !('user_ids' in payload)) return;
        const userIDs: unknown = payload.user_ids;
        if (Array.isArray(userIDs) && userIDs.every((userID: unknown): userID is string => typeof userID === 'string')) snapshots.push(userIDs);
      } catch {
        // Ignore unrelated or malformed WebSocket frames; the transport owns their validation.
      }
    });
  });
  return snapshots;
}

async function installNotificationStubs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const notificationRecords: Array<{title: string; body?: string; tag?: string}> = [];
    const audioState = {tones: 0, unlocks: 0};
    Object.defineProperty(window, '__zweiNotificationRecords', {configurable: true, value: notificationRecords});
    Object.defineProperty(window, '__zweiAudioState', {configurable: true, value: audioState});

    class TestNotification {
      public static permission = 'granted';
      public static requestPermission = async (): Promise<string> => 'granted';
      public onclick: (() => void) | null = null;

      public constructor(public readonly title: string, public readonly options: {body?: string; tag?: string}) {
        notificationRecords.push({title, body: options.body, tag: options.tag});
      }

      public close(): void {}
    }

    class TestAudioContext {
      public state = 'suspended';
      public currentTime = 0;
      public destination = {};

      public async resume(): Promise<void> {
        this.state = 'running';
        audioState.unlocks += 1;
      }

      public createOscillator() {
        audioState.tones += 1;
            return {
          type: 'sine',
          frequency: {setValueAtTime: (): void => {}},
          connect: (): void => {},
          start: (): void => {},
          stop: (): void => {},
        };
      }

      public createGain() {
        return {
          gain: {setValueAtTime: (): void => {}, exponentialRampToValueAtTime: (): void => {}},
          connect: (): void => {},
        };
      }
    }

    Object.defineProperty(window, 'Notification', {configurable: true, value: TestNotification});
    Object.defineProperty(window, 'AudioContext', {configurable: true, value: TestAudioContext});
  });
}

async function register(page: import('@playwright/test').Page, email: string, nickname: string): Promise<void> {
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
  await page.locator('form').waitFor();
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="firstName"]').fill(nickname);
  await page.locator('[formControlName="lastName"]').fill('Test');
  await page.locator('[formControlName="nickName"]').fill(nickname);
  await page.locator('[formControlName="password"]').fill('Password123!');
  await page.locator('[formControlName="confirmPassword"]').fill('Password123!');
  const submit = page.getByRole('button', { name: 'Create account' });
  await expect(submit).toBeEnabled();
  const responsePromise = page.waitForResponse(response => response.url().includes('/api/auth/register'));
  await submit.click();
  const response = await responsePromise;
  if (response.status() !== 201) {
    throw new Error(`registration failed: ${response.status()} ${await response.text()}`);
  }
  await expect(page).toHaveURL(/\/home$/);
}

async function login(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="password"]').fill('Password123!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function waitForLiveConnection(page: Page): Promise<void> {
  await expect.poll(async () => page.locator('.chat-presence').textContent(), {timeout: 10_000}).toBe('Live connection');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function authenticatedToken(context: import('@playwright/test').BrowserContext, email: string, deviceName: string): Promise<{access_token: string; token_type: string}> {
  const response = await context.request.post(`${adminBase}/api/auth/login`, {
    data: {email, password, device_id: `e2e-${deviceName}-${Date.now()}-${Math.random()}`, device_name: 'E2E'},
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<{access_token: string; token_type: string}>;
}

async function userID(context: import('@playwright/test').BrowserContext, token: {access_token: string; token_type: string}, email: string): Promise<string> {
  const response = await context.request.get(`${chatBase}/api/chat/users/search?q=${encodeURIComponent(email)}`, {
    headers: {Authorization: `${token.token_type} ${token.access_token}`},
  });
  expect(response.status()).toBe(200);
  const user = (await response.json() as Array<{id: string; email: string}>).find(item => item.email === email);
  if (!user) throw new Error(`search did not return ${email}`);
  return user.id;
}

async function currentUserID(context: import('@playwright/test').BrowserContext, token: {access_token: string; token_type: string}): Promise<string> {
  const response = await context.request.get(`${adminBase}/api/auth/me`, {
    headers: {Authorization: `${token.token_type} ${token.access_token}`},
  });
  expect(response.status()).toBe(200);
  return (await response.json() as {id: string}).id;
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const isLight = await page.locator('html').evaluate(element => element.classList.contains('light-theme'));
  if (isLight === (theme === 'light')) return;
  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: theme === 'light' ? 'Switch to light theme' : 'Switch to dark theme'}).click();
  await expect(page.locator('html')).toHaveClass(theme === 'light' ? /light-theme/ : /dark-theme/);
  await expect(page.locator('.cdk-overlay-backdrop-showing')).toHaveCount(0);
}

async function assertGroupSettingsOverlay(page: Page, testInfo: import('@playwright/test').TestInfo, theme: 'light' | 'dark', viewport: {width: number; height: number}): Promise<void> {
  const manager = page.locator('.chat-panel > .group-manager');
  const panel = manager.locator('.group-settings-panel');
  await expect(manager).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(manager.getByRole('textbox', {name: 'Name', exact: true})).toBeEnabled();
  await expect(manager.getByRole('textbox', {name: 'Find a person', exact: true})).toBeEnabled();
  await expect(manager.getByRole('button', {name: 'Save name'})).toBeVisible();
  await expect(manager.getByRole('button', {name: 'Add member'})).toBeVisible();
  // Acceptance matrix: top/end scroll positions in both themes at 1440x900 and 390x844.
  // The matrix is also exercised at the existing wider and tablet widths below.
  const assertSettingsBodyClearOfHeading = async (position: 'top' | 'end'): Promise<void> => {
    const geometry = await panel.evaluate((element, requestedPosition) => {
      const settings = element as HTMLElement;
      const card = settings.closest<HTMLElement>('.group-manager');
      const fixedHeading = card?.querySelector<HTMLElement>('.group-manager-heading');
      const description = settings.querySelector<HTMLElement>('#group-members-settings + p');
      if (!card || !fixedHeading || !description) throw new Error('Group settings heading or members description was not rendered');
      settings.scrollTop = requestedPosition === 'top' ? 0 : settings.scrollHeight;
      const headingRect = fixedHeading.getBoundingClientRect();
      const panelRect = settings.getBoundingClientRect();
      const descriptionRect = description.getBoundingClientRect();
      const visibleDescriptionTop = Math.max(descriptionRect.top, panelRect.top);
      const visibleDescriptionBottom = Math.min(descriptionRect.bottom, panelRect.bottom);
      const descriptionVisible = visibleDescriptionBottom > visibleDescriptionTop;
      const overlapsHeading = descriptionVisible
        && visibleDescriptionTop < headingRect.bottom
        && visibleDescriptionBottom > headingRect.top;
      const style = getComputedStyle(settings);
      const headingStyle = getComputedStyle(fixedHeading);
      const descriptionStyle = getComputedStyle(description);
      const managerRect = card.getBoundingClientRect();
      const textWalker = document.createTreeWalker(settings, NodeFilter.SHOW_TEXT);
      const overlappingText: Array<{text: string; top: number; bottom: number}> = [];
      let textNode = textWalker.nextNode();
      while (textNode) {
        if (textNode.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(textNode);
          for (const textRect of Array.from(range.getClientRects())) {
            const visibleTop = Math.max(textRect.top, panelRect.top);
            const visibleBottom = Math.min(textRect.bottom, panelRect.bottom);
            if (visibleBottom > visibleTop && visibleTop < headingRect.bottom && visibleBottom > headingRect.top) {
              overlappingText.push({text: textNode.textContent.trim(), top: visibleTop, bottom: visibleBottom});
            }
          }
        }
        textNode = textWalker.nextNode();
      }
      return {
        position: requestedPosition,
        scrollTop: settings.scrollTop,
        scrollHeight: settings.scrollHeight,
        clientHeight: settings.clientHeight,
        heading: {top: headingRect.top, bottom: headingRect.bottom},
        panel: {top: panelRect.top, bottom: panelRect.bottom},
        manager: {top: managerRect.top, bottom: managerRect.bottom, scrollHeight: card.scrollHeight, clientHeight: card.clientHeight},
        description: {top: descriptionRect.top, bottom: descriptionRect.bottom},
        styles: {panelOverflowY: style.overflowY, panelMarginTop: style.marginTop, panelClipPath: style.clipPath, headingPosition: headingStyle.position, descriptionLineHeight: descriptionStyle.lineHeight},
        overlapsHeading,
        overlappingText,
        headingGap: panelRect.top - headingRect.bottom,
      };
    }, position);
    if (position === 'top') expect(geometry.scrollTop, JSON.stringify({theme, viewport, geometry})).toBe(0);
    expect(geometry.panel.top, JSON.stringify({theme, viewport, geometry})).toBeGreaterThanOrEqual(geometry.heading.bottom + 7);
    expect(geometry.headingGap, JSON.stringify({theme, viewport, geometry})).toBeGreaterThanOrEqual(7);
    expect(geometry.styles.panelMarginTop, JSON.stringify({theme, viewport, geometry})).toBe('8px');
    expect(geometry.styles.panelClipPath, JSON.stringify({theme, viewport, geometry})).toBe('none');
    expect(geometry.manager.scrollHeight, JSON.stringify({theme, viewport, geometry})).toBeLessThanOrEqual(geometry.manager.clientHeight + 1);
    expect(geometry.overlapsHeading, JSON.stringify({theme, viewport, geometry})).toBeFalsy();
    expect(geometry.overlappingText, JSON.stringify({theme, viewport, geometry})).toEqual([]);
    if (position === 'end' && geometry.scrollHeight > geometry.clientHeight) {
      expect(geometry.scrollTop + geometry.clientHeight, JSON.stringify({theme, viewport, geometry})).toBeGreaterThanOrEqual(geometry.scrollHeight - 1);
    }
  };
  const top = await page.evaluate(expectedTheme => {
    const managerElement = document.querySelector<HTMLElement>('.chat-panel > .group-manager');
    const trigger = document.querySelector<HTMLElement>('.group-manage-trigger');
    const panelElement = managerElement?.querySelector<HTMLElement>('.group-settings-panel');
    const composer = document.querySelector<HTMLElement>('.composer');
    const heading = managerElement?.querySelector<HTMLElement>('.group-settings-section h3');
    const label = managerElement?.querySelector<HTMLElement>('.group-settings-section label');
    const member = managerElement?.querySelector<HTMLElement>('.group-members li');
    const firstActionMember = managerElement?.querySelector<HTMLElement>('.group-members li .member-actions')?.closest<HTMLElement>('li');
    const adminActionMember = Array.from(managerElement?.querySelectorAll<HTMLElement>('.group-members > li') ?? []).find(row => row.querySelector('.member-identity small')?.textContent?.trim() === 'admin' && row.querySelectorAll('.member-actions button').length === 3);
    const ownerMember = Array.from(managerElement?.querySelectorAll<HTMLElement>('.group-members > li') ?? []).find(row => row.querySelector('.member-identity small')?.textContent?.trim() === 'owner');
    const memberList = managerElement?.querySelector<HTMLElement>('.group-members');
    const memberName = member?.querySelector<HTMLElement>('strong');
    if (!managerElement || !trigger || !panelElement || !composer || !heading || !label || !member || !firstActionMember || !adminActionMember || !ownerMember || !memberList || !memberName) throw new Error('Group settings overlay, owner row, or three-action admin row was not fully rendered');
    panelElement.scrollTop = 0;
    memberList.scrollTop = 0;
    const managerRect = managerElement.getBoundingClientRect();
    const panelRect = panelElement.getBoundingClientRect();
    const memberListRect = memberList.getBoundingClientRect();
    const firstMemberRect = member.getBoundingClientRect();
    const firstActionMemberRect = firstActionMember.getBoundingClientRect();
    const firstActionRects = Array.from(firstActionMember.querySelectorAll<HTMLElement>('.member-actions button')).map(button => button.getBoundingClientRect());
    const adminActionMemberRect = adminActionMember.getBoundingClientRect();
    const adminActionRects = Array.from(adminActionMember.querySelectorAll<HTMLElement>('.member-actions button')).map(button => button.getBoundingClientRect());
    const ownerMemberRect = ownerMember.getBoundingClientRect();
    const ownerIdentityRect = ownerMember.querySelector<HTMLElement>('.member-identity')?.getBoundingClientRect();
    const listItems = Array.from(memberList.querySelectorAll<HTMLElement>(':scope > li'));
    const adjacentActionPair = listItems.slice(0, -1).map((row, index) => [row, listItems[index + 1]] as const)
      .find(([row, next]) => row.querySelector('.member-action-button') !== null && next.querySelector('.member-action-button') !== null);
    const actionRowPitch = adjacentActionPair
      ? adjacentActionPair[1].getBoundingClientRect().top - adjacentActionPair[0].getBoundingClientRect().top
      : undefined;
    const composerRect = composer.getBoundingClientRect();
    const luminance = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`Unexpected computed color: ${value}`);
      return channels.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    };
    const memberSecondary = Array.from(managerElement.querySelectorAll<HTMLElement>('.group-members li small')).map(text => {
      const foreground = getComputedStyle(text).color;
      const row = text.closest<HTMLElement>('li');
      const background = row ? getComputedStyle(row).backgroundColor : '';
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      return {text: text.textContent?.trim(), foreground, background, contrast: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05)};
    });
    return {
      theme: expectedTheme,
      viewportHeight: window.innerHeight,
      document: {scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth},
      manager: {top: managerRect.top, bottom: managerRect.bottom, scrollHeight: managerElement.scrollHeight, clientHeight: managerElement.clientHeight, background: getComputedStyle(managerElement).backgroundColor, color: getComputedStyle(managerElement).color},
      panel: {top: panelRect.top, bottom: panelRect.bottom, scrollTop: panelElement.scrollTop, scrollHeight: panelElement.scrollHeight, clientHeight: panelElement.clientHeight},
      firstMember: {top: firstMemberRect.top, bottom: firstMemberRect.bottom, listTop: memberListRect.top, listBottom: memberListRect.bottom, scrollTop: memberList.scrollTop},
      firstActionMember: {top: firstActionMemberRect.top, bottom: firstActionMemberRect.bottom, actions: firstActionRects.map(rect => ({top: rect.top, bottom: rect.bottom}))},
      adminActionMember: {name: adminActionMember.querySelector('.member-identity strong')?.textContent?.trim(), role: adminActionMember.querySelector('.member-identity small')?.textContent?.trim(), top: adminActionMemberRect.top, bottom: adminActionMemberRect.bottom, height: adminActionMemberRect.height, actionRowPitch, actions: adminActionRects.map(rect => ({width: rect.width, height: rect.height}))},
      ownerMember: {name: ownerMember.querySelector('.member-identity strong')?.textContent?.trim(), role: ownerMember.querySelector('.member-identity small')?.textContent?.trim(), height: ownerMemberRect.height, identityHeight: ownerIdentityRect?.height, actionCount: ownerMember.querySelectorAll('.member-actions button').length},
      memberSecondary,
      composerTop: composerRect.top,
      heading: getComputedStyle(heading).color,
      label: getComputedStyle(label).color,
       member: {background: getComputedStyle(member).backgroundColor, color: getComputedStyle(memberName).color},
       trigger: {background: getComputedStyle(trigger).backgroundColor, color: getComputedStyle(trigger).color},
    };
  }, theme);
  expect(top.document.scrollWidth).toBeLessThanOrEqual(top.document.clientWidth + 1);
  expect(top.manager.bottom).toBeLessThanOrEqual(top.viewportHeight + 1);
  expect(top.manager.bottom).toBeLessThanOrEqual(top.composerTop + 1);
  expect(top.panel.top).toBeGreaterThanOrEqual(top.manager.top - 1);
  expect(top.panel.bottom).toBeLessThanOrEqual(top.manager.bottom + 1);
  expect(top.manager.scrollHeight).toBeLessThanOrEqual(top.manager.clientHeight + 1);
  expect(top.firstMember.scrollTop).toBe(0);
  expect(top.firstMember.top).toBeGreaterThanOrEqual(top.firstMember.listTop - 1);
  expect(top.firstMember.bottom).toBeLessThanOrEqual(top.firstMember.listBottom + 1);
  expect(top.firstMember.bottom).toBeLessThanOrEqual(top.panel.bottom + 1);
  expect(top.firstActionMember.bottom, JSON.stringify({theme, viewport, firstActionMember: top.firstActionMember, panel: top.panel})).toBeLessThanOrEqual(top.panel.bottom + 1);
  expect(top.firstActionMember.actions.every(action => action.top >= top.panel.top && action.bottom <= top.panel.bottom + 1), JSON.stringify({theme, viewport, top})).toBeTruthy();
  expect(top.ownerMember.role).toBe('owner');
  expect(top.ownerMember.actionCount).toBe(0);
  expect(top.ownerMember.height).toBeLessThanOrEqual(70);
  expect(top.ownerMember.identityHeight).toBeLessThanOrEqual(top.ownerMember.height);
  expect(top.memberSecondary.length).toBeGreaterThan(0);
  for (const secondary of top.memberSecondary) expect(secondary.contrast, `${theme} member role contrast ${JSON.stringify(secondary)}`).toBeGreaterThanOrEqual(4.5);
  if (theme === 'light') {
    expect(top.manager.background).toBe('rgb(255, 255, 255)');
    expect(top.manager.color).toBe('rgb(23, 32, 51)');
    expect(top.heading).toBe('rgb(23, 32, 51)');
    expect(top.label).toBe('rgb(23, 32, 51)');
    expect(top.member.background).toBe('rgb(250, 249, 253)');
    expect(top.member.color).toBe('rgb(23, 32, 51)');
    expect(top.trigger.background).toBe('rgb(250, 249, 253)');
    expect(top.trigger.color).toBe('rgb(75, 156, 233)');
  } else {
    expect(top.manager.background).toBe('rgb(32, 44, 59)');
    expect(top.heading).toBe('rgb(241, 245, 249)');
    expect(top.label).toBe('rgb(237, 242, 250)');
    expect(top.member.background).toBe('rgb(38, 53, 70)');
  }
  await assertSettingsBodyClearOfHeading('top');
  await page.screenshot({path: testInfo.outputPath(`group-settings-${theme}-${viewport.width}-top.png`), fullPage: false, timeout: 15_000});

  const inspectMemberEdge = async (edge: 'top' | 'end') => panel.evaluate(async (element, requestedEdge) => {
    const settings = element as HTMLElement;
    const members = settings.querySelector<HTMLElement>('.group-members');
    const listItems = Array.from(members?.querySelectorAll<HTMLElement>(':scope > li') ?? []);
    const target = requestedEdge === 'top' ? listItems[0] : listItems[listItems.length - 1];
    const actionRow = requestedEdge === 'top'
      ? listItems.find(row => row.querySelector('.member-actions button'))
      : [...listItems].reverse().find(row => row.querySelector('.member-actions button'));
    const heading = settings.closest<HTMLElement>('.group-manager')?.querySelector<HTMLElement>('.group-manager-heading');
    const access = settings.querySelector<HTMLElement>('.group-danger-zone');
    if (!members || !target || !heading || !access) throw new Error('Member scroller, edge row, heading, or Group access was not rendered');
    settings.scrollTop = 0;
    if (requestedEdge === 'top') {
      members.scrollTop = 0;
    } else {
      const lastRow = listItems[listItems.length - 1];
      if (!lastRow) throw new Error('Last member row was not rendered');
      const listRect = members.getBoundingClientRect();
      const lastRowRect = lastRow.getBoundingClientRect();
      members.scrollTop += lastRowRect.bottom - listRect.bottom;
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const listRect = members.getBoundingClientRect();
    const rowRect = target.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const accessRect = access.getBoundingClientRect();
    const actionRowRect = actionRow?.getBoundingClientRect();
    const actionStyle = actionRow?.querySelector<HTMLElement>('.member-actions');
    const actions = Array.from(actionRow?.querySelectorAll<HTMLElement>('.member-actions button') ?? []).map(button => {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {label: button.getAttribute('aria-label'), width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden', inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight, containedInRow: !!actionRowRect && rect.top >= actionRowRect.top - 1 && rect.bottom <= actionRowRect.bottom + 1 && rect.left >= actionRowRect.left - 1 && rect.right <= actionRowRect.right + 1, clearOfHeading: rect.top >= headingRect.bottom + 7, clearOfAccess: rect.bottom <= accessRect.top + 1};
    });
    const fullyInsideList = (rect: {top: number; bottom: number; left: number; right: number}) => rect.top >= listRect.top - 1 && rect.bottom <= listRect.bottom + 1 && rect.left >= listRect.left - 1 && rect.right <= listRect.right + 1;
    const visibleRows = listItems.filter(row => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > listRect.top && rect.top < listRect.bottom;
    }).map(row => {
      const rect = row.getBoundingClientRect();
      const text = Array.from(row.querySelectorAll<HTMLElement>('.member-identity strong, .member-identity small')).map(element => {
        const textRect = element.getBoundingClientRect();
        return {value: element.textContent?.trim(), top: textRect.top, bottom: textRect.bottom, left: textRect.left, right: textRect.right, fullyVisible: fullyInsideList(textRect) && textRect.top >= 0 && textRect.bottom <= window.innerHeight};
      });
      const rowActions = Array.from(row.querySelectorAll<HTMLElement>('.member-actions button')).map(button => {
        const actionRect = button.getBoundingClientRect();
        return {name: button.getAttribute('aria-label'), width: actionRect.width, height: actionRect.height, top: actionRect.top, bottom: actionRect.bottom, left: actionRect.left, right: actionRect.right, fullyVisible: fullyInsideList(actionRect) && actionRect.top >= 0 && actionRect.bottom <= window.innerHeight};
      });
      return {name: row.querySelector('.member-identity')?.textContent?.trim(), top: rect.top, bottom: rect.bottom, fullyVisible: fullyInsideList(rect) && rect.top >= 0 && rect.bottom <= window.innerHeight, text, actions: rowActions};
    });
    return {
      edge: requestedEdge,
      memberScroller: {scrollTop: members.scrollTop, scrollHeight: members.scrollHeight, clientHeight: members.clientHeight, scrollWidth: members.scrollWidth, clientWidth: members.clientWidth, paddingBottom: Number.parseFloat(getComputedStyle(members).paddingBottom), overflowY: getComputedStyle(members).overflowY},
      panel: {scrollTop: settings.scrollTop, scrollHeight: settings.scrollHeight, clientHeight: settings.clientHeight},
      list: {top: listRect.top, bottom: listRect.bottom},
      row: {name: target.textContent?.trim(), top: rowRect.top, bottom: rowRect.bottom, left: rowRect.left, right: rowRect.right, inViewport: rowRect.top >= 0 && rowRect.bottom <= window.innerHeight, contained: fullyInsideList(rowRect)},
      actionRow: actionRowRect ? {name: actionRow?.textContent?.trim(), top: actionRowRect.top, bottom: actionRowRect.bottom, height: actionRowRect.height, display: actionRow ? getComputedStyle(actionRow).display : undefined, direction: actionRow ? getComputedStyle(actionRow).flexDirection : undefined, cssHeight: actionRow ? getComputedStyle(actionRow).height : undefined, overflow: actionRow ? getComputedStyle(actionRow).overflow : undefined, actionsTop: actionStyle?.getBoundingClientRect().top, actionsBottom: actionStyle?.getBoundingClientRect().bottom, actionsHeight: actionStyle?.getBoundingClientRect().height, actionsPosition: actionStyle ? getComputedStyle(actionStyle).position : undefined, inViewport: actionRowRect.top >= 0 && actionRowRect.bottom <= window.innerHeight, contained: fullyInsideList(actionRowRect)} : undefined,
      heading: {top: headingRect.top, bottom: headingRect.bottom},
      access: {top: accessRect.top, bottom: accessRect.bottom},
      actions,
      visibleRows,
      actionsContained: actions.length > 0 && actions.every(action => action.visible && action.containedInRow && action.clearOfHeading && action.clearOfAccess && fullyInsideList(action)),
    };
  }, edge);
  const memberTop = await inspectMemberEdge('top');
  expect(memberTop.memberScroller.overflowY).toBe('auto');
  expect(memberTop.memberScroller.scrollHeight, JSON.stringify({theme, viewport, memberScroller: memberTop.memberScroller})).toBeGreaterThan(memberTop.memberScroller.clientHeight);
  expect(memberTop.memberScroller.scrollTop).toBe(0);
  expect(memberTop.panel.scrollTop).toBe(0);
  expect(memberTop.row.contained, JSON.stringify({theme, viewport, memberTop})).toBeTruthy();
  expect(memberTop.row.inViewport, JSON.stringify({theme, viewport, memberTop})).toBeTruthy();
  expect(memberTop.row.name).toBeTruthy();
  expect(memberTop.row.top, JSON.stringify({theme, viewport, memberTop})).toBeGreaterThanOrEqual(memberTop.heading.bottom + 7);
  expect(memberTop.row.bottom, JSON.stringify({theme, viewport, memberTop})).toBeLessThanOrEqual(memberTop.access.top + 1);
  expect(memberTop.actionRow?.contained, JSON.stringify({theme, viewport, memberTop})).toBeTruthy();
  expect(memberTop.actionRow?.inViewport, JSON.stringify({theme, viewport, memberTop})).toBeTruthy();
  expect(memberTop.actionRow?.top, JSON.stringify({theme, viewport, memberTop})).toBeGreaterThanOrEqual(memberTop.heading.bottom + 7);
  expect(memberTop.actionRow?.bottom, JSON.stringify({theme, viewport, memberTop})).toBeLessThanOrEqual(memberTop.access.top + 1);
  expect(memberTop.actions.every(action => action.inViewport), JSON.stringify({theme, viewport, memberTop})).toBeTruthy();
  expect(memberTop.actions.every(action => action.width >= 44 && action.height >= 44 && !!action.label?.trim()), JSON.stringify({theme, viewport, memberTop})).toBeTruthy();
  expect(memberTop.actionsContained, JSON.stringify({theme, viewport, memberTop})).toBeTruthy();
  expect(memberTop.visibleRows.length).toBeGreaterThan(0);
  const fullyVisibleTopRows = memberTop.visibleRows.filter(row => row.fullyVisible);
  expect(fullyVisibleTopRows.length).toBeGreaterThan(0);
  expect(fullyVisibleTopRows.every(row => row.actions.every(action => action.fullyVisible)), JSON.stringify({theme, viewport, visibleRows: memberTop.visibleRows})).toBeTruthy();
  expect(memberTop.memberScroller.scrollWidth).toBeLessThanOrEqual(memberTop.memberScroller.clientWidth + 1);
  if (theme === 'light' && viewport.width === 1440) {
    const measured = top.adminActionMember;
    expect(measured.role).toBe('admin');
    expect(measured.actions).toHaveLength(3);
    expect(measured.height).toBeLessThanOrEqual(91.2);
    expect(measured.height).toBeLessThanOrEqual(114 * 0.8);
    expect(measured.actionRowPitch).toBeLessThanOrEqual(91.2);
    const buttonWidths = measured.actions.map(action => action.width);
    const combinedButtonWidth = buttonWidths.reduce((sum, width) => sum + width, 0);
    expect(buttonWidths.every(width => width >= 44)).toBeTruthy();
    expect(combinedButtonWidth).toBeLessThanOrEqual(187.2);
    expect(combinedButtonWidth).toBeLessThanOrEqual(267.42 * 0.7);
    console.log(`GROUP_MEMBER_ACTION_COMPACTNESS ${JSON.stringify({theme, viewport, rowHeight: measured.height, baselineRowHeight: 114, rowHeightReduction: 1 - measured.height / 114, buttonWidths, combinedButtonWidth, baselineCombinedButtonWidth: 267.42, combinedWidthReduction: 1 - combinedButtonWidth / 267.42})}`);

  }
  const adminActionRow = page.locator('.group-members > li').filter({has: page.locator('.member-identity small').getByText('admin', {exact: true})});
  const actionButtons = [
    {id: 'make-member', label: 'Make member', ariaLabel: 'Make Member 1 a member', button: adminActionRow.getByRole('button', {name: 'Make Member 1 a member', exact: true})},
    {id: 'transfer-owner', label: 'Transfer owner', ariaLabel: 'Transfer ownership to Member 1', button: adminActionRow.getByRole('button', {name: 'Transfer ownership to Member 1', exact: true})},
    {id: 'remove-member', label: 'Remove', ariaLabel: 'Remove Member 1', button: adminActionRow.getByRole('button', {name: 'Remove Member 1', exact: true})},
  ];
  const assertTooltipGeometry = async (action: typeof actionButtons[number]): Promise<void> => {
    const tooltip = page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface').filter({hasText: action.label}).last();
    await expect(tooltip, `${theme} ${viewport.width}px tooltip: ${action.label}`).toBeVisible();
    await expect(page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface:visible'), `${theme} ${viewport.width}px must render only the active action tooltip`).toHaveCount(1);
    const contrast = await measureRenderedTextContrast(tooltip);
    expect(contrast.ratio, `${theme} ${viewport.width}px ${action.label} rendered contrast: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
    const {tooltipRect, managerRect} = await page.evaluate(label => {
      const toRect = (element: Element | null) => {
        const rect = element?.getBoundingClientRect();
        return rect ? {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height} : undefined;
      };
      const tooltipElements = Array.from(document.querySelectorAll<HTMLElement>('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface'))
        .filter(element => element.textContent?.trim() === label);
      return {
        tooltipRect: toRect(tooltipElements[tooltipElements.length - 1] ?? null),
        managerRect: toRect(document.querySelector('.chat-panel > .group-manager')),
      };
    }, action.label);
    if (!tooltipRect || !managerRect) throw new Error(`Tooltip or group settings geometry was unavailable for ${action.label}: ${JSON.stringify({tooltipRect, managerRect})}`);
    expect(tooltipRect.width, JSON.stringify({theme, viewport, action: action.id, tooltipRect})).toBeGreaterThan(0);
    expect(tooltipRect.height, JSON.stringify({theme, viewport, action: action.id, tooltipRect})).toBeGreaterThan(0);
    const tip = {left: tooltipRect.left, right: tooltipRect.right, top: tooltipRect.top, bottom: tooltipRect.bottom};
    expect(tip.left, JSON.stringify({theme, viewport, action: action.id, tip, managerRect})).toBeGreaterThanOrEqual(managerRect.left - 1);
    expect(tip.right, JSON.stringify({theme, viewport, action: action.id, tip, managerRect})).toBeLessThanOrEqual(managerRect.right + 1);
    expect(tip.top, JSON.stringify({theme, viewport, action: action.id, tip})).toBeGreaterThanOrEqual(0);
    expect(tip.bottom, JSON.stringify({theme, viewport, action: action.id, tip})).toBeLessThanOrEqual(viewport.height);
    const collisions = await manager.evaluate((element, tooltipRect) => {
      const intersects = (rect: DOMRect) => rect.left < tooltipRect.right && rect.right > tooltipRect.left && rect.top < tooltipRect.bottom && rect.bottom > tooltipRect.top;
      const controls = Array.from(element.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="button"], [role="option"]'))
        .map(control => {
          const rect = control.getBoundingClientRect();
          return {label: control.getAttribute('aria-label') || control.getAttribute('name') || control.innerText.trim(), rect: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}};
        }).filter(control => intersects(new DOMRect(control.rect.left, control.rect.top, control.rect.right - control.rect.left, control.rect.bottom - control.rect.top)));
      const rows = Array.from(element.querySelectorAll<HTMLElement>('.group-members > li'))
        .map(row => {
          const rect = row.getBoundingClientRect();
          return {label: row.querySelector('.member-identity')?.textContent?.trim(), rect: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}};
        }).filter(row => intersects(new DOMRect(row.rect.left, row.rect.top, row.rect.right - row.rect.left, row.rect.bottom - row.rect.top)));
      return {controls, rows};
    }, tip);
    expect(collisions.controls, `${theme} ${viewport.width}px ${action.label} overlaps a group control: ${JSON.stringify(collisions)}`).toEqual([]);
    expect(collisions.rows, `${theme} ${viewport.width}px ${action.label} overlaps a member row: ${JSON.stringify(collisions)}`).toEqual([]);
  };
  const focusUsingKeyboard = async (button: typeof actionButtons[number]['button']): Promise<void> => {
    await page.mouse.move(0, 0);
    await button.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(button).toBeFocused();
  };
  const visibleTooltips = page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface:visible');
  const memberScroller = manager.locator('.group-members');
  const scrollMemberListAwayFromCurrentEdge = async (): Promise<{before: number; targetScrollTop: number; scrollTop: number; scrollHeight: number; clientHeight: number; maxScroll: number; scrollEvents: number}> => memberScroller.evaluate(element => new Promise(resolve => {
    const list = element as HTMLElement;
    const before = list.scrollTop;
    const maxScroll = list.scrollHeight - list.clientHeight;
    const targetScrollTop = before < maxScroll - 1 ? maxScroll : 0;
    let scrollEvents = 0;
    let completed = false;
    const finish = (): void => {
      if (completed) return;
      completed = true;
      list.removeEventListener('scroll', onScroll);
      window.clearTimeout(timeout);
      resolve({before, targetScrollTop, scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, maxScroll, scrollEvents});
    };
    const onScroll = (): void => {
      scrollEvents++;
      requestAnimationFrame(() => requestAnimationFrame(finish));
    };
    const timeout = window.setTimeout(finish, 1_000);
    list.addEventListener('scroll', onScroll);
    list.scrollTop = targetScrollTop;
  }));
  for (const action of actionButtons) {
    await expect(action.button).toHaveAttribute('aria-label', action.ariaLabel);
    await action.button.scrollIntoViewIfNeeded();
    await page.mouse.move(1, viewport.height / 2);
    await action.button.hover();
    await assertTooltipGeometry(action);
    await waitForTooltipAnimation(visibleTooltips);
    await page.screenshot({path: testInfo.outputPath(`group-member-action-tooltip-hover-${action.id}-${theme}-${viewport.width}.png`), fullPage: false});
    await focusUsingKeyboard(action.button);
    await assertTooltipGeometry(action);
    await waitForTooltipAnimation(visibleTooltips);
    await page.screenshot({path: testInfo.outputPath(`group-member-action-${action.id}-keyboard-focus-${theme}-${viewport.width}.png`), fullPage: false});
    if (action.id === 'transfer-owner' && viewport.width === 1440) {
      const focusStyle = await action.button.evaluate(button => ({outlineStyle: getComputedStyle(button).outlineStyle, outlineWidth: getComputedStyle(button).outlineWidth}));
      expect(focusStyle.outlineStyle).not.toBe('none');
      expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(3);
    }
  }
  if (viewport.width === 1440 && theme === 'dark') {
    const resizeTooltip = page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface').filter({hasText: 'Remove'}).last();
    await page.mouse.move(1, viewport.height / 2);
    await actionButtons[2].button.hover();
    await expect(resizeTooltip).toBeVisible();
    await page.setViewportSize({width: 390, height: 844});
    await expect(resizeTooltip, 'resizing while a member tooltip is open must dismiss it').not.toBeVisible();
    await expect(page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface:visible')).toHaveCount(0);
    await page.setViewportSize(viewport);
    await expect(actionButtons[2].button, 'resizing should retain keyboard focus on the action').toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(actionButtons[2].button, 'keyboard navigation should recover the focused action tooltip without moving the pointer').toBeFocused();
    await assertTooltipGeometry(actionButtons[2]);
    await waitForTooltipAnimation(resizeTooltip);
    await page.screenshot({path: testInfo.outputPath('group-member-action-remove-keyboard-recovered-after-resize-dark-1440.png'), fullPage: false});
    const focusRecoveryScroll = await scrollMemberListAwayFromCurrentEdge();
    expect(focusRecoveryScroll.targetScrollTop, JSON.stringify(focusRecoveryScroll)).not.toBe(focusRecoveryScroll.before);
    expect(focusRecoveryScroll.scrollEvents, JSON.stringify(focusRecoveryScroll)).toBeGreaterThan(0);
    if (focusRecoveryScroll.targetScrollTop === 0) expect(focusRecoveryScroll.scrollTop).toBe(0);
    else expect(focusRecoveryScroll.scrollTop + focusRecoveryScroll.clientHeight).toBeGreaterThanOrEqual(focusRecoveryScroll.scrollHeight - 1);
    await expect(resizeTooltip, 'keyboard-recovered tooltip must dismiss on a subsequent list scroll').not.toBeVisible();
    await page.mouse.move(1, viewport.height / 2);
    await expect(resizeTooltip, 'pointer movement outside after scroll must not resurrect the tooltip').not.toBeVisible();
    await actionButtons[2].button.evaluate(button => (button as HTMLButtonElement).blur());
    await expect(visibleTooltips).toHaveCount(0);
    await memberScroller.evaluate(element => { element.scrollTop = 0; });
    await panel.evaluate(element => { element.scrollTop = 0; });
    await page.mouse.move(0, 0);
  }
  const removeTooltip = page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface').filter({hasText: 'Remove'}).last();
  await focusUsingKeyboard(actionButtons[2].button);
  await assertTooltipGeometry(actionButtons[2]);
  await page.mouse.move(0, 0);
  await actionButtons[2].button.hover();
  await assertTooltipGeometry(actionButtons[2]);
  const listScroll = await scrollMemberListAwayFromCurrentEdge();
  expect(listScroll.targetScrollTop, JSON.stringify({theme, viewport, listScroll})).not.toBe(listScroll.before);
  expect(listScroll.scrollEvents, JSON.stringify({theme, viewport, listScroll})).toBeGreaterThan(0);
   if (listScroll.targetScrollTop === 0) expect(listScroll.scrollTop).toBe(0);
   else expect(listScroll.scrollTop + listScroll.clientHeight).toBeGreaterThanOrEqual(listScroll.scrollHeight - 1);
   await expect(removeTooltip, `${theme} ${viewport.width}px tooltip must clear when the member list scrolls`).not.toBeVisible();
   await expect(visibleTooltips).toHaveCount(0);
   await actionButtons[2].button.scrollIntoViewIfNeeded();
   await expect(actionButtons[2].button, `${theme} ${viewport.width}px list scroll should retain keyboard focus`).toBeFocused();
   await page.keyboard.press('Shift+Tab');
   await page.keyboard.press('Tab');
   await expect(actionButtons[2].button, `${theme} ${viewport.width}px keyboard focus should recover without pointer movement`).toBeFocused();
   await assertTooltipGeometry(actionButtons[2]);
   await waitForTooltipAnimation(removeTooltip);
   await expect(removeTooltip, `${theme} ${viewport.width}px keyboard focus should reopen after a list scroll`).toBeVisible();
   await page.screenshot({path: testInfo.outputPath(`group-member-action-remove-keyboard-recovered-after-list-scroll-${theme}-${viewport.width}.png`), fullPage: false});
   const dismissalScroll = await scrollMemberListAwayFromCurrentEdge();
   expect(dismissalScroll.targetScrollTop, JSON.stringify({theme, viewport, dismissalScroll})).not.toBe(dismissalScroll.before);
   expect(dismissalScroll.scrollEvents, JSON.stringify({theme, viewport, dismissalScroll})).toBeGreaterThan(0);
   await expect(removeTooltip, `${theme} ${viewport.width}px a following scroll must dismiss the recovered tooltip`).not.toBeVisible();
   await page.mouse.move(1, viewport.height / 2);
   await expect(removeTooltip, `${theme} ${viewport.width}px pointer movement must not resurrect a dismissed tooltip`).not.toBeVisible();
   await actionButtons[2].button.hover();
   await assertTooltipGeometry(actionButtons[2]);
   await waitForTooltipAnimation(removeTooltip);
   await expect(removeTooltip).toBeVisible();
  const settingsScroll = await panel.evaluate(element => {
    const settings = element as HTMLElement;
    settings.scrollTop = settings.scrollHeight;
    return {scrollTop: settings.scrollTop, scrollHeight: settings.scrollHeight, clientHeight: settings.clientHeight};
  });
  if (settingsScroll.scrollHeight > settingsScroll.clientHeight + 1) {
    expect(settingsScroll.scrollTop, JSON.stringify({theme, viewport, settingsScroll})).toBeGreaterThan(0);
    await expect(removeTooltip, `${theme} ${viewport.width}px tooltip must clear when settings scroll away from its target`).not.toBeVisible();
    await expect(visibleTooltips).toHaveCount(0);
    await expect(manager.getByRole('heading', {name: 'Group name'})).toBeVisible();
    await expect(manager.getByRole('button', {name: 'Save name'})).toBeVisible();
    await manager.getByRole('button', {name: 'Save name'}).focus();
    await page.screenshot({path: testInfo.outputPath(`group-settings-${theme}-${viewport.width}-name-controls-no-stale-tooltip.png`), fullPage: false});
  } else {
    await expect(removeTooltip).toBeVisible();
  }
  await panel.evaluate(element => { element.scrollTop = 0; });
  await memberScroller.evaluate(element => { element.scrollTop = 0; });

  await page.emulateMedia({reducedMotion: 'reduce'});
  await manager.getByRole('textbox', {name: 'Find a person'}).focus();
  const reducedMotionStyle = await actionButtons[0].button.evaluate(button => ({animationName: getComputedStyle(button).animationName, transitionDuration: getComputedStyle(button).transitionDuration}));
  expect(reducedMotionStyle.animationName).toBe('none');
  expect(Number.parseFloat(reducedMotionStyle.transitionDuration)).toBeLessThanOrEqual(0.001);
  await page.screenshot({path: testInfo.outputPath(`group-member-actions-reduced-motion-${theme}-${viewport.width}.png`), fullPage: false});
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.screenshot({path: testInfo.outputPath(`group-settings-${theme}-${viewport.width}-members-top.png`), fullPage: false, timeout: 15_000});

  const memberEnd = await inspectMemberEdge('end');
  expect(memberEnd.memberScroller.scrollTop + memberEnd.memberScroller.clientHeight).toBeGreaterThanOrEqual(memberEnd.memberScroller.scrollHeight - memberEnd.memberScroller.paddingBottom - 1);
  expect(memberEnd.panel.scrollTop).toBe(0);
  expect(memberEnd.row.contained, JSON.stringify({theme, viewport, memberEnd})).toBeTruthy();
  expect(memberEnd.row.inViewport, JSON.stringify({theme, viewport, memberEnd})).toBeTruthy();
  expect(memberEnd.row.name).toBeTruthy();
  expect(memberEnd.row.top, JSON.stringify({theme, viewport, memberEnd})).toBeGreaterThanOrEqual(memberEnd.heading.bottom + 7);
  expect(memberEnd.row.bottom, JSON.stringify({theme, viewport, memberEnd})).toBeLessThanOrEqual(memberEnd.access.top + 1);
  expect(memberEnd.actionRow?.contained, JSON.stringify({theme, viewport, memberEnd})).toBeTruthy();
  expect(memberEnd.actionRow?.inViewport, JSON.stringify({theme, viewport, memberEnd})).toBeTruthy();
  expect(memberEnd.actionRow?.top, JSON.stringify({theme, viewport, memberEnd})).toBeGreaterThanOrEqual(memberEnd.heading.bottom + 7);
  expect(memberEnd.actionRow?.bottom, JSON.stringify({theme, viewport, memberEnd})).toBeLessThanOrEqual(memberEnd.access.top + 1);
  expect(memberEnd.actions.every(action => action.inViewport), JSON.stringify({theme, viewport, memberEnd})).toBeTruthy();
  expect(memberEnd.actionsContained, JSON.stringify({theme, viewport, memberEnd})).toBeTruthy();
  expect(memberEnd.visibleRows.length).toBeGreaterThan(0);
  const fullyVisibleEndRows = memberEnd.visibleRows.filter(row => row.fullyVisible);
  expect(fullyVisibleEndRows.length).toBeGreaterThan(0);
  expect(fullyVisibleEndRows.every(row => row.actions.every(action => action.fullyVisible)), JSON.stringify({theme, viewport, visibleRows: memberEnd.visibleRows})).toBeTruthy();
  const clippedEndActions = memberEnd.visibleRows.flatMap(row => row.actions.filter(action => !action.fullyVisible).map(action => ({row: row.name, action: action.name, top: action.top, bottom: action.bottom})));
  expect(clippedEndActions, `${theme} ${viewport.width}px end scroll clips action targets: ${JSON.stringify({memberScroller: memberEnd.memberScroller, list: memberEnd.list, visibleRows: memberEnd.visibleRows, clippedEndActions})}`).toEqual([]);
  const clippedEndText = memberEnd.visibleRows.flatMap(row => row.text.filter(text => !text.fullyVisible).map(text => ({row: row.name, text: text.value, top: text.top, bottom: text.bottom})));
  expect(clippedEndText, `${theme} ${viewport.width}px end scroll clips member text: ${JSON.stringify({memberScroller: memberEnd.memberScroller, list: memberEnd.list, visibleRows: memberEnd.visibleRows, clippedEndText})}`).toEqual([]);
  expect(memberEnd.memberScroller.scrollWidth).toBeLessThanOrEqual(memberEnd.memberScroller.clientWidth + 1);
  console.log(`GROUP_MEMBER_END_GEOMETRY ${JSON.stringify({theme, viewport, memberScroller: memberEnd.memberScroller, list: memberEnd.list, visibleRows: memberEnd.visibleRows})}`);
  await expect(visibleTooltips).toHaveCount(0);
  await page.screenshot({path: testInfo.outputPath(`group-settings-${theme}-${viewport.width}-members-end-no-tooltip.png`), fullPage: false, timeout: 15_000});
  const lastRemoveButton = manager.locator('.group-members .member-action-button[aria-label^="Remove "]').last();
  await lastRemoveButton.scrollIntoViewIfNeeded();
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.mouse.move(1, viewport.height / 2);
  await lastRemoveButton.hover();
  await assertTooltipGeometry(actionButtons[2]);
  await page.screenshot({path: testInfo.outputPath(`group-member-action-remove-hover-list-end-${theme}-${viewport.width}.png`), fullPage: false});
  const endSettingsScroll = await panel.evaluate(element => {
    const settings = element as HTMLElement;
    settings.scrollTop = settings.scrollHeight;
    return {scrollTop: settings.scrollTop, scrollHeight: settings.scrollHeight, clientHeight: settings.clientHeight};
  });
  if (endSettingsScroll.scrollHeight > endSettingsScroll.clientHeight + 1) {
    expect(endSettingsScroll.scrollTop, JSON.stringify({theme, viewport, endSettingsScroll})).toBeGreaterThan(0);
    await expect(visibleTooltips).toHaveCount(0);
    await expect(manager.getByRole('heading', {name: 'Group name'})).toBeVisible();
    await expect(manager.getByRole('button', {name: 'Save name'})).toBeVisible();
    await manager.getByRole('button', {name: 'Save name'}).focus();
    await page.screenshot({path: testInfo.outputPath(`group-settings-${theme}-${viewport.width}-list-end-scrolled-away-no-tooltip.png`), fullPage: false});
  }

  const end = await panel.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    const panelRect = element.getBoundingClientRect();
    const danger = element.querySelector<HTMLElement>('.group-danger-zone');
    const dangerRect = danger?.getBoundingClientRect();
    return {scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, dangerTop: dangerRect?.top, dangerBottom: dangerRect?.bottom, panelTop: panelRect.top, panelBottom: panelRect.bottom, viewportHeight: window.innerHeight};
  });
  if (viewport.width === 390) expect(end.scrollHeight).toBeGreaterThan(end.clientHeight);
  expect(end.dangerTop, JSON.stringify(end)).toBeGreaterThanOrEqual(end.panelTop - 1);
  expect(end.dangerBottom).toBeLessThanOrEqual(end.panelBottom + 1);
  expect(end.dangerBottom).toBeLessThanOrEqual(end.viewportHeight + 1);
  if (end.scrollHeight > end.clientHeight) expect(end.scrollTop + end.clientHeight).toBeGreaterThanOrEqual(end.scrollHeight - 1);
  await assertSettingsBodyClearOfHeading('end');
  await page.screenshot({path: testInfo.outputPath(`group-settings-${theme}-${viewport.width}-end.png`), fullPage: false, timeout: 15_000});
}

async function assertGroupLayout(page: Page, testInfo: import('@playwright/test').TestInfo, theme: 'light' | 'dark', viewport: {width: number; height: number}): Promise<void> {
  await page.setViewportSize(viewport);
  await setTheme(page, theme);
  await expect(page.locator('.group-members')).toBeVisible();
  await expect(page.locator('.message-history')).toBeVisible();
  const composer = page.locator('.composer textarea');
  await expect(composer).toBeEnabled({timeout: 10_000});
  await expect(composer).toHaveAttribute('placeholder', 'Write a message…');
  const composerPlaceholder = await measureRenderedTextContrastAtSurface(composer, '::placeholder');
  expect(composerPlaceholder.opacity, `${theme}/${viewport.width} active composer placeholder opacity`).toBeGreaterThan(0);
  expect(composerPlaceholder.ratio, `${theme}/${viewport.width} active composer placeholder contrast: ${JSON.stringify(composerPlaceholder)}`).toBeGreaterThanOrEqual(4.5);
  await assertGroupSettingsOverlay(page, testInfo, theme, viewport);
  await page.evaluate(() => {
    for (const selector of ['.message-history', '.people-list']) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element) element.scrollTop = 0;
    }
  });
  const topMetrics = await page.evaluate(() => {
    const contained = (element: HTMLElement, child: HTMLElement | null) => {
      const rect = element.getBoundingClientRect();
      const childRect = child?.getBoundingClientRect();
      return !childRect || (childRect.top >= rect.top - 1 && childRect.bottom <= rect.bottom + 1 && childRect.left >= rect.left - 1 && childRect.right <= rect.right + 1);
    };
    const history = document.querySelector<HTMLElement>('.message-history');
    const rail = document.querySelector<HTMLElement>('.people-list');
    if (!history || !rail) throw new Error('Group scroll regions were not rendered');
    return {
      document: {scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth},
      messages: {scrollTop: history.scrollTop, scrollHeight: history.scrollHeight, clientHeight: history.clientHeight, scrollWidth: history.scrollWidth, clientWidth: history.clientWidth, firstContained: contained(history, history.querySelector('.message-bubble'))},
      rail: {visible: rail.getBoundingClientRect().height > 0, scrollWidth: rail.scrollWidth, clientWidth: rail.clientWidth},
    };
  });
  expect(topMetrics.document.scrollWidth).toBeLessThanOrEqual(topMetrics.document.clientWidth + 1);
  expect(topMetrics.messages.scrollWidth).toBeLessThanOrEqual(topMetrics.messages.clientWidth + 1);
  if (topMetrics.rail.visible) expect(topMetrics.rail.scrollWidth).toBeLessThanOrEqual(topMetrics.rail.clientWidth + 1);
  expect(topMetrics.messages.firstContained).toBeTruthy();
  await page.screenshot({path: testInfo.outputPath(`group-${theme}-${viewport.width}-top.png`), fullPage: false, timeout: 15_000});

  const endMetrics = await page.evaluate(() => {
    const contained = (element: HTMLElement, child: HTMLElement | null) => {
      const rect = element.getBoundingClientRect();
      const childRect = child?.getBoundingClientRect();
      return !childRect || (childRect.top >= rect.top - 1 && childRect.bottom <= rect.bottom + 1 && childRect.left >= rect.left - 1 && childRect.right <= rect.right + 1);
    };
    const history = document.querySelector<HTMLElement>('.message-history');
    const rail = document.querySelector<HTMLElement>('.people-list');
    if (!history || !rail) throw new Error('Group scroll regions were not rendered');
    history.scrollTop = history.scrollHeight;
    rail.scrollTop = rail.scrollHeight;
    return {
      messages: {scrollTop: history.scrollTop, scrollHeight: history.scrollHeight, clientHeight: history.clientHeight, lastContained: contained(history, history.querySelector('.message-bubble:last-child'))},
      rail: {visible: rail.getBoundingClientRect().height > 0, scrollTop: rail.scrollTop, scrollHeight: rail.scrollHeight, clientHeight: rail.clientHeight, lastContained: contained(rail, rail.lastElementChild as HTMLElement | null)},
    };
  });
  expect(endMetrics.messages.lastContained).toBeTruthy();
  if (endMetrics.rail.visible) expect(endMetrics.rail.lastContained).toBeTruthy();
  expect(endMetrics.messages.scrollTop + endMetrics.messages.clientHeight).toBeGreaterThanOrEqual(endMetrics.messages.scrollHeight - 1);
  if (endMetrics.rail.visible) expect(endMetrics.rail.scrollTop + endMetrics.rail.clientHeight).toBeGreaterThanOrEqual(endMetrics.rail.scrollHeight - 1);
  await page.screenshot({path: testInfo.outputPath(`group-${theme}-${viewport.width}-end.png`), fullPage: false, timeout: 15_000});

  // Acceptance matrix: representative rendered list titles versus timestamps at 2560, 1440,
  // 1024, and 390px, in both themes. At mobile the rail must be opened to inspect its actual DOM.
  if (viewport.width === 390) await page.getByRole('button', {name: 'Back to chats'}).click();
  await assertConversationTitleAvoidsTimestamp(page, theme, viewport);
  if (viewport.width === 390) {
    await page.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'}).click();
    await expect(page.locator('.group-members')).toBeVisible();
  }
}

async function assertMobileGroupRail(page: Page, testInfo: import('@playwright/test').TestInfo, theme: 'light' | 'dark'): Promise<void> {
  await page.setViewportSize({width: 390, height: 844});
  await setTheme(page, theme);
  await page.getByRole('button', {name: 'Back to chats'}).click();
  const rail = page.locator('.people-list');
  await expect(rail).toBeVisible();
  await rail.evaluate(element => { element.scrollTop = 0; });
  const top = await rail.evaluate(element => ({scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, first: element.firstElementChild?.getBoundingClientRect(), rail: element.getBoundingClientRect()}));
  expect(top.scrollWidth).toBeLessThanOrEqual(top.clientWidth + 1);
  expect(top.first?.top).toBeGreaterThanOrEqual(top.rail.top - 1);
  await page.screenshot({path: testInfo.outputPath(`group-rail-${theme}-390-top.png`), fullPage: false, timeout: 15_000});
  const end = await rail.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    const last = element.lastElementChild?.getBoundingClientRect();
    const railRect = element.getBoundingClientRect();
    return {scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, lastBottom: last?.bottom, railBottom: railRect.bottom};
  });
  expect(end.scrollTop).toBeGreaterThan(0);
  expect(end.scrollTop + end.clientHeight).toBeGreaterThanOrEqual(end.scrollHeight - 1);
  expect(end.lastBottom).toBeLessThanOrEqual(end.railBottom + 1);
  await page.screenshot({path: testInfo.outputPath(`group-rail-${theme}-390-end.png`), fullPage: false, timeout: 15_000});
  await page.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'}).click();
  const settingsToggle = page.locator('.group-manager-heading button');
  await expect(settingsToggle).toBeVisible();
  if (await settingsToggle.textContent() === 'Manage group') await settingsToggle.click();
  await expect(settingsToggle).toHaveText('Close');
  await expect(page.locator('.group-members')).toBeVisible();
}

async function callThemeColors(page: Page): Promise<{panel: string; text: string; card: string; cardText: string; action: string; actionText: string; device: string; control: string; controlBorder: string; icon: string; scrollTrack: string; scrollThumb: string}> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.call-panel');
    const card = document.querySelector<HTMLElement>('.call-card');
    const action = document.querySelector<HTMLElement>('.call-actions');
    const actionButton = document.querySelector<HTMLElement>('.call-presentation-icon-actions button');
    const device = document.querySelector<HTMLElement>('.call-devices .call-select');
    const control = document.querySelector<HTMLElement>('.call-presentation-icon-actions button');
    const icon = document.querySelector<HTMLElement>('.call-button');
    const scrollSurface = document.querySelector<HTMLElement>('.message-history');
    const panelStyle = panel ? getComputedStyle(panel) : undefined;
    const cardStyle = card ? getComputedStyle(card) : undefined;
    const actionStyle = action ? getComputedStyle(action) : undefined;
    const actionButtonStyle = actionButton ? getComputedStyle(actionButton) : undefined;
    const deviceStyle = device ? getComputedStyle(device) : undefined;
    const scrollStyle = scrollSurface ? getComputedStyle(scrollSurface) : undefined;
    return {
      panel: panelStyle?.backgroundColor || '',
      text: panelStyle?.color || '',
      card: cardStyle?.backgroundColor || '',
      cardText: cardStyle?.color || '',
      action: actionStyle?.backgroundColor || '',
      actionText: actionButtonStyle?.color || '',
      device: deviceStyle?.backgroundColor || '',
      control: control ? getComputedStyle(control).color : '',
      controlBorder: control ? getComputedStyle(control).borderTopColor : '',
      icon: icon ? getComputedStyle(icon).color : '',
      scrollTrack: scrollStyle?.getPropertyValue('--chat-scroll-track').trim() || '',
      scrollThumb: scrollStyle?.getPropertyValue('--chat-scroll-thumb').trim() || '',
    };
  });
}

async function installDeterministicGroupMedia(page: Page, color: string): Promise<void> {
  await page.addInitScript(fill => {
    Object.defineProperty(window, '__groupSyncRequests', {configurable: true, value: [] as string[]});
    Object.defineProperty(window, '__groupLocalTracks', {configurable: true, value: [] as MediaStreamTrack[]});
    Object.defineProperty(window, '__groupPeerConnections', {configurable: true, value: [] as RTCPeerConnection[]});
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, argumentsList, newTarget) {
        const connection = Reflect.construct(target, argumentsList, newTarget) as RTCPeerConnection;
        (window as Window & {__groupPeerConnections: RTCPeerConnection[]}).__groupPeerConnections.push(connection);
        return connection;
      },
    });
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data: Parameters<WebSocket['send']>[0]): void {
      if (typeof data === 'string') {
        try {
          const event = JSON.parse(data) as {type?: string; request_id?: string};
          if (event.type === 'group.call.sync') (window as Window & {__groupSyncRequests: string[]}).__groupSyncRequests.push(event.request_id ?? '');
        } catch { /* Preserve non-JSON application frames. */ }
      }
      originalSend.call(this, data);
    };
    const mediaDevices = navigator.mediaDevices;
    const createAudioStream = (): MediaStream => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.001;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      const stream = destination.stream;
      (window as Window & {__groupLocalTracks: MediaStreamTrack[]}).__groupLocalTracks.push(...stream.getTracks());
      return stream;
    };
    const createPresentation = (): MediaStream => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d');
      let frame = 0;
      if (context) {
        context.fillStyle = fill;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      const stream = canvas.captureStream(0);
      const videoTrack = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
      if (context && videoTrack) window.setInterval(() => {
        context.fillStyle = fill;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = frame % 2 === 0 ? '#ffffff' : '#000000';
        context.fillRect(24, 24, 24, 24);
        frame += 1;
        videoTrack.requestFrame();
      }, 100);
      return stream;
    };
    Object.defineProperty(mediaDevices, 'getUserMedia', {configurable: true, value: async () => createAudioStream()});
    Object.defineProperty(mediaDevices, 'getDisplayMedia', {configurable: true, value: async () => createPresentation()});
    Object.defineProperty(mediaDevices, 'enumerateDevices', {configurable: true, value: async () => [
      {deviceId: 'group-mic', groupId: 'group-audio', kind: 'audioinput', label: 'Group test microphone', toJSON: () => ({})},
      {deviceId: 'group-speaker', groupId: 'group-audio', kind: 'audiooutput', label: 'Group test speaker', toJSON: () => ({})},
    ]});
    const audio = HTMLMediaElement.prototype as HTMLMediaElement & {setSinkId?: (deviceID: string) => Promise<void>};
    if (!audio.setSinkId) Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {configurable: true, value: async () => undefined});
    Object.defineProperty(HTMLAudioElement.prototype, 'play', {configurable: true, value: function(this: HTMLAudioElement): Promise<void> {
      Object.defineProperty(this, 'paused', {configurable: true, get: () => false});
      return Promise.resolve();
    }});
  }, color);
}

async function assertGroupCallAudioConnected(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const connections = (window as Window & {__groupPeerConnections?: RTCPeerConnection[]}).__groupPeerConnections ?? [];
    const connectedPeers = connections.filter(connection => connection.connectionState === 'connected' && connection.remoteDescription !== null
      && connection.getReceivers().some(receiver => receiver.track.kind === 'audio' && receiver.track.readyState === 'live'));
    const audios = Array.from(document.querySelectorAll<HTMLAudioElement>('.group-call-panel audio'));
    const playingRemoteAudio = audios.length > 0 && audios.every(audio => !audio.paused && audio.srcObject instanceof MediaStream
      && audio.srcObject.active && audio.srcObject.getAudioTracks().some(track => track.readyState === 'live'));
    return connectedPeers.length > 0 && audios.length > 0 && playingRemoteAudio;
  }), {timeout: 20_000}).toBeTruthy();
  const mediaState = await page.evaluate(() => {
    const connections = (window as Window & {__groupPeerConnections?: RTCPeerConnection[]}).__groupPeerConnections ?? [];
    return {
      connectedPeerCount: connections.filter(connection => connection.connectionState === 'connected' && connection.remoteDescription !== null
        && connection.getReceivers().some(receiver => receiver.track.kind === 'audio' && receiver.track.readyState === 'live')).length,
      remoteAudioCount: Array.from(document.querySelectorAll<HTMLAudioElement>('.group-call-panel audio')).filter(audio => !audio.paused
        && audio.srcObject instanceof MediaStream && audio.srcObject.active && audio.srcObject.getAudioTracks().some(track => track.readyState === 'live')).length,
    };
  });
  expect(mediaState.connectedPeerCount, JSON.stringify(mediaState)).toBeGreaterThan(0);
  expect(mediaState.remoteAudioCount, JSON.stringify(mediaState)).toBeGreaterThan(0);
}

async function assertChatPresenceContrast(page: Page, theme: 'light' | 'dark', expectedText: string): Promise<void> {
  const presence = page.locator('.chat-header .chat-presence');
  await expect(presence).toHaveText(expectedText, {timeout: 10_000});
  const metrics = await presence.evaluate(element => {
    const channels = (value: string): number[] => {
      const result = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!result || result.length !== 3) throw new Error(`Unexpected computed color: ${value}`);
      return result;
    };
    const luminance = (value: string): number => channels(value).map(channel => channel / 255)
      .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const foreground = getComputedStyle(element).color;
    const header = element.closest<HTMLElement>('.chat-header');
    if (!header) throw new Error('Selected conversation header was not rendered');
    const background = getComputedStyle(header).backgroundColor;
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return {label: element.textContent?.trim(), foreground, background, inlineStyle: element.getAttribute('style'), htmlTheme: document.documentElement.className, bodyTheme: document.body.className, contrast: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05)};
  });
  expect(metrics.contrast, `${theme} ${expectedText} header presence ${JSON.stringify(metrics)}`).toBeGreaterThanOrEqual(4.5);
}

async function assertGroupPresenceContrast(page: Page, testInfo: import('@playwright/test').TestInfo, theme: 'light' | 'dark'): Promise<void> {
  await setTheme(page, theme);
  const presenceText = await page.locator('.chat-header .chat-presence').textContent();
  if (!presenceText || !/[1-9]\d* members online/.test(presenceText)) throw new Error(`Expected online group presence, received ${presenceText}`);
  await assertChatPresenceContrast(page, theme, presenceText);
  await page.screenshot({path: testInfo.outputPath(`group-presence-${theme}-selected.png`), fullPage: false, timeout: 15_000});
}

async function assertConversationTitleAvoidsTimestamp(page: Page, theme: 'light' | 'dark', viewport: {width: number; height: number}): Promise<void> {
  await expect(page.locator('.people-list')).toBeVisible();
  await expect(page.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'})).toBeVisible();
  await expect(page.locator('.person-option .conversation-time').first()).toBeVisible();
  const rows = await page.locator('.person-option').evaluateAll(elements => elements
    .map(element => {
      const title = element.querySelector<HTMLElement>('.conversation-copy strong');
      const subtitle = element.querySelector<HTMLElement>('.conversation-copy small');
      const timestamp = element.querySelector<HTMLElement>('.conversation-time');
      const rail = element.closest<HTMLElement>('.conversation-rail');
      if (!title || !subtitle || !timestamp || !rail) return null;
      const titleRect = title.getBoundingClientRect();
      const subtitleRect = subtitle.getBoundingClientRect();
      const timestampRect = timestamp.getBoundingClientRect();
      const parseColor = (value: string): [number, number, number, number] => {
        const channels = value.match(/[\d.]+/g)?.map(Number);
        if (!channels || channels.length < 3) throw new Error(`Unexpected computed color: ${value}`);
        return [channels[0], channels[1], channels[2], channels[3] ?? 1];
      };
      const composite = (foreground: [number, number, number, number], background: [number, number, number, number]): [number, number, number, number] => {
        const alpha = foreground[3] + background[3] * (1 - foreground[3]);
        return [0, 1, 2].map(index => alpha === 0 ? 0 : (foreground[index] * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha).concat(alpha) as [number, number, number, number];
      };
      const luminance = (color: [number, number, number, number]): number => color.slice(0, 3).map(channel => {
        const normalized = channel / 255;
        return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
      }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
      const colorContrast = (foreground: string, background: string): number => {
        const backgroundColor = parseColor(background);
        const surface = backgroundColor[3] < 1 ? composite(backgroundColor, parseColor(getComputedStyle(rail).backgroundColor)) : backgroundColor;
        const text = composite(parseColor(foreground), surface);
        const foregroundLuminance = luminance(text);
        const backgroundLuminance = luminance(surface);
        return (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05);
      };
      const rowBackground = getComputedStyle(element).backgroundColor;
      return {
        row: element.textContent?.trim(),
        title: {left: titleRect.left, right: titleRect.right, top: titleRect.top, bottom: titleRect.bottom},
        subtitle: {visible: subtitleRect.width > 0 && subtitleRect.height > 0, foreground: getComputedStyle(subtitle).color, background: rowBackground, contrast: colorContrast(getComputedStyle(subtitle).color, rowBackground)},
        timestamp: {left: timestampRect.left, right: timestampRect.right, top: timestampRect.top, bottom: timestampRect.bottom},
        timestampContrast: {foreground: getComputedStyle(timestamp).color, background: rowBackground, contrast: colorContrast(getComputedStyle(timestamp).color, rowBackground)},
        visible: titleRect.width > 0 && titleRect.height > 0 && timestampRect.width > 0 && timestampRect.height > 0,
      };
    }).filter((row): row is NonNullable<typeof row> => row !== null && row.visible));
  expect(rows.length, `Expected rendered conversation rows at ${theme}/${viewport.width}`).toBeGreaterThan(0);
  for (const row of rows) {
    const overlaps = row.title.left < row.timestamp.right && row.title.right > row.timestamp.left
      && row.title.top < row.timestamp.bottom && row.title.bottom > row.timestamp.top;
    expect(overlaps, `${theme}/${viewport.width} conversation title overlaps its timestamp: ${JSON.stringify(row)}`).toBeFalsy();
    expect(row.timestampContrast.contrast, `${theme}/${viewport.width} timestamp contrast: ${JSON.stringify(row.timestampContrast)}`).toBeGreaterThanOrEqual(4.5);
    if (row.subtitle.visible) expect(row.subtitle.contrast, `${theme}/${viewport.width} conversation subtitle contrast: ${JSON.stringify(row.subtitle)}`).toBeGreaterThanOrEqual(4.5);
  }
}

async function assertEmptyMessageContrast(page: Page, theme: 'light' | 'dark', viewport: {width: number; height: number}): Promise<void> {
  const emptyMessage = page.locator('.empty-messages p');
  await expect(emptyMessage).toHaveText('No messages yet.');
  const metrics = await emptyMessage.evaluate(element => {
    const channels = (value: string): number[] => {
      const result = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!result || result.length !== 3) throw new Error(`Unexpected computed color: ${value}`);
      return result;
    };
    const luminance = (value: string): number => channels(value).map(channel => {
      const normalized = channel / 255;
      return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const history = element.closest<HTMLElement>('.message-history');
    if (!history) throw new Error('Empty message history surface was not rendered');
    const foreground = getComputedStyle(element).color;
    const background = getComputedStyle(history).backgroundColor;
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return {text: element.textContent?.trim(), foreground, background, backgroundImage: getComputedStyle(history).backgroundImage, contrast: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05)};
  });
  expect(metrics.contrast, `${theme}/${viewport.width} empty-state contrast ${JSON.stringify(metrics)}`).toBeGreaterThanOrEqual(4.5);
}

async function assertAccountMenuContrast(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const menu = page.getByRole('menu');
  const metrics = await menu.evaluate(async menuElement => {
    const panel = menuElement.closest<HTMLElement>('.mat-mdc-menu-panel') ?? menuElement;
    const overlay = panel.closest<HTMLElement>('.cdk-overlay-pane') ?? panel;
    await Promise.all(overlay.getAnimations({subtree: true}).map(animation => animation.finished.catch(() => undefined)));
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const renderedOpacity = (): number => {
      let opacity = 1;
      for (let ancestor: HTMLElement | null = panel; ancestor; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
      return opacity;
    };
    const animationDeadline = performance.now() + 2_000;
    while (renderedOpacity() < .999 && performance.now() < animationDeadline) await frame();
    if (renderedOpacity() < .999) throw new Error(`Account menu did not finish rendering at full opacity: ${renderedOpacity()}`);
    await frame();
    await frame();

    type RGBA = [number, number, number, number];
    const parse = (value: string): RGBA => {
      const channels = value.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length < 3) throw new Error(`Unexpected computed color: ${value}`);
      return [channels[0], channels[1], channels[2], channels[3] ?? 1];
    };
    const composite = (foreground: RGBA, background: RGBA): RGBA => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      return [0, 1, 2].map(index => alpha === 0 ? 0 : (foreground[index] * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha).concat(alpha) as RGBA;
    };
    const luminance = (color: RGBA): number => color.slice(0, 3).map(channel => {
      const linear = channel / 255;
      return linear <= .04045 ? linear / 12.92 : ((linear + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const contrast = (foreground: RGBA, background: RGBA): number => {
      const effective = luminance(foreground);
      const backdrop = luminance(background);
      return (Math.max(effective, backdrop) + .05) / (Math.min(effective, backdrop) + .05);
    };
    const background = parse(getComputedStyle(panel).backgroundColor);
    const effectiveOpacity = (element: HTMLElement): number => {
      let opacity = 1;
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
      return opacity;
    };
    const items = Array.from(menuElement.querySelectorAll<HTMLElement>('.mat-mdc-menu-item')).filter(item => item.getBoundingClientRect().height > 0).map(item => {
      const text = item.querySelector<HTMLElement>('.mat-mdc-menu-item-text') ?? item;
      const color = parse(getComputedStyle(text).color);
      color[3] *= effectiveOpacity(text);
      const itemBackground = parse(getComputedStyle(item).backgroundColor);
      const renderedBackground = composite(itemBackground, background);
      const renderedForeground = composite(color, renderedBackground);
      return {label: item.innerText.trim(), contrast: contrast(renderedForeground, renderedBackground), opacity: effectiveOpacity(text) * parse(getComputedStyle(text).color)[3]};
    });
    const identities = Array.from(menuElement.querySelectorAll<HTMLElement>('.account-menu-name, .account-menu-email')).filter(item => item.getBoundingClientRect().height > 0).map(item => {
      const text = item.querySelector<HTMLElement>('.mat-mdc-menu-item-text') ?? item;
      const foreground = parse(getComputedStyle(text).color);
      foreground[3] *= effectiveOpacity(text);
      const itemBackground = composite(parse(getComputedStyle(item).backgroundColor), background);
      return {
        label: item.innerText.trim(),
        disabled: item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true',
        opacity: effectiveOpacity(text) * parse(getComputedStyle(text).color)[3],
        contrast: contrast(composite(foreground, itemBackground), itemBackground),
      };
    });
    return {
      background: getComputedStyle(panel).backgroundColor,
      backgroundAlpha: background[3],
      panelOpacity: effectiveOpacity(panel),
      classes: Array.from(panel.classList),
      items,
      identities,
    };
  });
  expect(metrics.classes).toContain(theme === 'dark' ? 'account-menu-panel-dark' : 'account-menu-panel-light');
  expect(metrics.background, `${theme} menu surface`).toBe(theme === 'dark' ? 'rgb(38, 53, 70)' : 'rgb(255, 255, 255)');
  expect(metrics.backgroundAlpha, `${theme} menu surface alpha`).toBe(1);
  expect(metrics.panelOpacity, `${theme} menu rendered opacity`).toBe(1);
  expect(metrics.items.length).toBeGreaterThan(0);
  expect(metrics.identities).toHaveLength(2);
  for (const identity of metrics.identities) {
    expect(identity.disabled, `${theme} account identity must be disabled`).toBeTruthy();
    expect(identity.opacity, `${theme} identity opacity ${JSON.stringify(identity)}`).toBe(1);
    expect(identity.contrast, `${theme} identity contrast ${JSON.stringify(identity)}`).toBeGreaterThanOrEqual(4.5);
  }
  for (const item of metrics.items) {
    expect(item.opacity, `${theme} menu text opacity ${JSON.stringify(item)}`).toBe(1);
    expect(item.contrast, `${theme} menu item contrast ${JSON.stringify(item)}`).toBeGreaterThanOrEqual(4.5);
  }
}

async function assertGroupCallLayout(page: Page, testInfo: import('@playwright/test').TestInfo, theme: 'light' | 'dark', viewport: {width: number; height: number}): Promise<{surface: string; text: string}> {
  await page.setViewportSize(viewport);
  await setTheme(page, theme);
  await page.waitForTimeout(300);
    const panel = page.locator('.group-call-panel');
  await expect(panel).toBeVisible();
    const metrics = await panel.evaluate(element => {
      const panelRect = element.getBoundingClientRect();
      const controls = Array.from(element.querySelectorAll<HTMLElement>('button, [role="combobox"]')).map(control => {
      const rect = control.getBoundingClientRect();
      return {label: control.getAttribute('aria-label') || control.innerText.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
    });
      const video = element.querySelector<HTMLVideoElement>('.group-presentation')?.getBoundingClientRect();
      const card = element.querySelector<HTMLElement>('.group-call-card');
      const cardRect = card?.getBoundingClientRect();
       const select = element.querySelector<HTMLElement>('.group-call-devices .call-select');
       const selectors = Array.from(element.querySelectorAll<HTMLElement>('.group-call-devices .call-select')).map(control => control.getBoundingClientRect());
       const actionRow = element.querySelector<HTMLElement>('.group-call-actions')?.getBoundingClientRect();
    const headerTitle = document.querySelector<HTMLElement>('.chat-header .group-title-row h2')?.getBoundingClientRect();
    const headerAction = document.querySelector<HTMLElement>('.chat-header > .call-button')?.getBoundingClientRect();
       const selectText = select?.querySelector<HTMLElement>('.mat-mdc-select-value-text, .mat-mdc-select-value');
      const action = element.querySelector<HTMLElement>('.group-call-actions .mat-mdc-outlined-button');
      const endAction = element.querySelector<HTMLElement>('.group-call-actions button[mat-flat-button][color="warn"]');
      const luminance = (color: string): number => (color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(channel => Number(channel) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)) || 0;
       const iconActions = Array.from(element.querySelectorAll<HTMLElement>('app-call-icon-actions .call-presentation-icon-actions button')).map(button => button.getBoundingClientRect());
    const contains = (rect: DOMRect) => rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1 && rect.top >= panelRect.top - 1 && rect.bottom <= panelRect.bottom + 1;
    const style = getComputedStyle(element);
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      panelScrollWidth: element.scrollWidth,
      panelClientWidth: element.clientWidth,
      controlsContained: controls.every(control => contains(new DOMRect(control.left, control.top, control.right - control.left, control.bottom - control.top))),
      controlsInViewport: controls.every(control => control.top >= 0 && control.bottom <= window.innerHeight),
      cardContained: !!cardRect && contains(cardRect),
      controlBounds: controls,
      headerTitleContained: !headerTitle || !headerAction || headerTitle.right <= headerAction.left + 1,
      videoContained: !video || contains(video),
      surface: style.backgroundColor,
       text: style.color,
       card: card ? {background: getComputedStyle(card).backgroundColor, color: getComputedStyle(card).color} : undefined,
      select: select ? {background: getComputedStyle(select).backgroundColor, color: getComputedStyle(select).color, text: selectText ? getComputedStyle(selectText).color : '', value: selectText?.textContent?.trim() || select.textContent?.trim() || ''} : undefined,
      action: action ? {background: getComputedStyle(action).backgroundColor, color: getComputedStyle(action).color, border: getComputedStyle(action).borderTopColor} : undefined,
      endAction: endAction ? {background: getComputedStyle(endAction).backgroundColor, color: getComputedStyle(endAction).color, contrast: (() => { const background = luminance(getComputedStyle(endAction).backgroundColor); const foreground = luminance(getComputedStyle(endAction).color); return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05); })()} : undefined,
      iconActions: iconActions.map(rect => ({left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height})),
    };
  });
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
  expect(metrics.panelScrollWidth).toBeLessThanOrEqual(metrics.panelClientWidth + 1);
   expect(metrics.controlsContained, JSON.stringify({viewport, controls: metrics.controlBounds})).toBeTruthy();
   expect(metrics.controlsInViewport).toBeTruthy();
   expect(metrics.cardContained).toBeTruthy();
   expect(metrics.headerTitleContained).toBeTruthy();
   expect(metrics.videoContained).toBeTruthy();
   expect(metrics.surface).not.toBe(metrics.text);
    if (!metrics.card || !metrics.select || !metrics.action) throw new Error('Group call controls were not fully rendered');
    expect(metrics.select.value.length).toBeGreaterThan(0);
    if (!metrics.endAction) throw new Error('Group call end action was not rendered');
    expect(metrics.endAction.color).toBe('rgb(255, 255, 255)');
    expect(metrics.endAction.contrast).toBeGreaterThanOrEqual(4.5);
    expect(metrics.iconActions).toHaveLength(2);
    expect(metrics.iconActions[0].right).toBeLessThanOrEqual(metrics.iconActions[1].left + 1);
    expect(metrics.iconActions[0].width).toBeGreaterThanOrEqual(44);
    expect(metrics.iconActions[1].height).toBeGreaterThanOrEqual(44);
   const controlsEnd = await page.locator('.group-call-content').evaluate(element => {
     const content = element as HTMLElement;
     content.scrollTop = content.scrollHeight;
     const contentRect = content.getBoundingClientRect();
     const selectors = Array.from(content.querySelectorAll<HTMLElement>('[role="combobox"]')).map(select => select.getBoundingClientRect());
     const actionRow = document.querySelector<HTMLElement>('.group-call-actions');
     const actionRect = actionRow?.getBoundingClientRect();
     const iconActions = Array.from(actionRow?.querySelectorAll<HTMLElement>('.call-presentation-icon-actions button') || []).map(button => button.getBoundingClientRect());
     return {scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, contentRect, selectors, actionRect, iconActions};
   });
   expect(controlsEnd.scrollTop + controlsEnd.clientHeight).toBeGreaterThanOrEqual(controlsEnd.scrollHeight - 1);
   expect(controlsEnd.selectors).toHaveLength(3);
   const lastSelector = controlsEnd.selectors[controlsEnd.selectors.length - 1];
   expect(lastSelector.top).toBeGreaterThanOrEqual(controlsEnd.contentRect.top - 1);
   expect(lastSelector.bottom).toBeLessThanOrEqual(controlsEnd.contentRect.bottom + 1);
   expect(controlsEnd.actionRect).toBeDefined();
   expect(controlsEnd.actionRect?.top).toBeGreaterThanOrEqual(controlsEnd.contentRect.bottom - 1);
   expect(controlsEnd.iconActions).toHaveLength(2);
   for (const button of controlsEnd.iconActions) {
     expect(button.top).toBeGreaterThanOrEqual(controlsEnd.actionRect?.top || 0);
     expect(button.bottom).toBeLessThanOrEqual((controlsEnd.actionRect?.bottom || 0) + 1);
     expect(button.bottom).toBeLessThanOrEqual(viewport.height + 1);
   }
   await page.screenshot({path: testInfo.outputPath(`group-call-${theme}-${viewport.width}-controls-end.png`), fullPage: false, timeout: 15_000});
   if (theme === 'light') {
     expect(metrics.card.background).toBe('rgb(255, 255, 255)');
     expect(metrics.card.color).toBe('rgb(23, 32, 51)');
     expect(metrics.select.background).toBe('rgb(255, 255, 255)');
     expect(metrics.select.color).toBe('rgb(23, 32, 51)');
     expect(metrics.select.text).toBe('rgb(23, 32, 51)');
     expect(metrics.action.background).toBe('rgb(250, 249, 253)');
     expect(metrics.action.color).toBe('rgb(23, 32, 51)');
      expect(metrics.action.border).toBe('rgb(207, 217, 232)');
   }
  await page.screenshot({path: testInfo.outputPath(`group-call-${theme}-${viewport.width}.png`), fullPage: false, timeout: 15_000});
  if (viewport.width === 1440) {
    await page.getByRole('button', {name: 'Account menu'}).click();
    const accountMenu = page.locator('.mat-mdc-menu-panel');
    await expect(accountMenu).toBeVisible();
    await assertAccountMenuContrast(page, theme);
    await page.screenshot({path: testInfo.outputPath(`group-call-account-menu-${theme}-${viewport.width}.png`), fullPage: false, timeout: 15_000});
    await page.keyboard.press('Escape');
  }
  return {surface: metrics.surface, text: metrics.text};
}

test('direct call offers and answers connect in the browser UI', async ({browser}, testInfo) => {
  test.setTimeout(90_000);
  const aliceEmail = uniqueEmail('direct-call-alice');
  const bobEmail = uniqueEmail('direct-call-bob');
  const aliceContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const bobContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const aliceSignals: string[] = [];
  const bobSignals: string[] = [];
  const captureSignals = (page: Page, signals: string[]): void => {
    page.on('websocket', socket => socket.on('framesent', frame => {
      if (typeof frame.payload !== 'string') return;
      let decoded: unknown;
      try { decoded = JSON.parse(frame.payload); } catch { return; }
      if (!isRecord(decoded) || decoded.type !== 'call.signal' || !isRecord(decoded.payload) || !isRecord(decoded.payload.signal)) return;
      const signalType = decoded.payload.signal.type;
      if (typeof signalType === 'string') signals.push(signalType);
    }));
  };
  captureSignals(alice, aliceSignals);
  captureSignals(bob, bobSignals);

  try {
    await register(alice, aliceEmail, 'Alice');
    await register(bob, bobEmail, 'Bob');
    await Promise.all([waitForLiveConnection(alice), waitForLiveConnection(bob)]);
    await alice.getByPlaceholder('Name or email').fill(bobEmail);
    const aliceResult = alice.locator('.search-result').filter({hasText: bobEmail});
    await expect(aliceResult).toBeVisible();
    await aliceResult.click();
    await expect(alice.getByRole('button', {name: 'Start audio call'})).toBeEnabled();
    await bob.getByPlaceholder('Name or email').fill(aliceEmail);
    const bobResult = bob.locator('.search-result').filter({hasText: aliceEmail});
    await expect(bobResult).toBeVisible();
    await bobResult.click();
    await expect(bob.getByPlaceholder('Write a message…')).toBeEnabled();

    await alice.getByRole('button', {name: 'Start audio call'}).click();
    await expect(alice.getByText('Ringing...')).toBeVisible();
    await expect(bob.getByText('Incoming audio call.')).toBeVisible();
    await bob.getByRole('button', {name: 'Accept'}).click();
    await expect(alice.getByText('Audio call connected.')).toBeVisible({timeout: 10_000});
    await expect(bob.getByText('Audio call connected.')).toBeVisible({timeout: 10_000});
      await expect(alice.getByLabel('Microphone input', {exact: true})).toBeVisible();
      await expect(alice.getByLabel('Speaker output', {exact: true})).toBeVisible();
      await expect(alice.getByLabel('Screen share quality', {exact: true})).toBeVisible();
      for (const deviceLabel of ['Microphone input', 'Speaker output', 'Screen share quality']) {
        expect((await alice.getByLabel(deviceLabel, {exact: true}).innerText()).trim()).not.toBe('');
      }
    await expect.poll(() => aliceSignals.includes('offer')).toBeTruthy();
    await expect.poll(() => bobSignals.includes('answer')).toBeTruthy();
    for (const theme of ['dark', 'light'] as const) {
      await setTheme(alice, theme);
      for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
        await alice.setViewportSize(viewport);
        await expect(alice.locator('.call-panel-full')).toBeVisible();
        const metrics = await alice.evaluate(() => {
          const panel = document.querySelector<HTMLElement>('.call-panel-full');
          const card = panel?.querySelector<HTMLElement>('.call-card');
          const profile = panel?.querySelector<HTMLElement>('.call-card > app-call-profile');
          const profileName = profile?.querySelector<HTMLElement>('.call-presentation-copy strong');
          const controls = Array.from(panel?.querySelectorAll<HTMLElement>('.call-devices [role="combobox"], .call-presentation-icon-actions button, .call-actions button') || []);
          const end = panel?.querySelector<HTMLElement>('.call-actions button[mat-flat-button][color="warn"]');
          const cardRect = card?.getBoundingClientRect();
          return {
            viewportWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            card: cardRect ? {left: cardRect.left, right: cardRect.right} : undefined,
            profileSurface: profile ? getComputedStyle(profile).backgroundColor : '',
            profileText: profileName ? getComputedStyle(profileName).color : '',
            controls: controls.map(control => { const rect = control.getBoundingClientRect(); return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}; }),
            endBottom: end?.getBoundingClientRect().bottom,
            viewportHeight: window.innerHeight,
          };
        });
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
        expect(metrics.card).toBeDefined();
        expect(metrics.controls).not.toHaveLength(0);
        if (theme === 'light') {
          expect(metrics.profileSurface).toBe('rgb(255, 255, 255)');
          expect(metrics.profileText).toBe('rgb(23, 32, 51)');
        }
        for (const control of metrics.controls) {
          expect(control.left).toBeGreaterThanOrEqual((metrics.card?.left || 0) - 1);
          expect(control.right).toBeLessThanOrEqual((metrics.card?.right || 0) + 1);
          expect(control.bottom).toBeGreaterThan(control.top);
        }
        expect(metrics.endBottom).toBeDefined();
        expect(metrics.endBottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
        await alice.screenshot({path: testInfo.outputPath(`direct-call-active-${theme}-${viewport.width}.png`), fullPage: false});
      }
    }

    await setTheme(alice, 'light');
    await alice.setViewportSize({width: 390, height: 844});
    await alice.getByRole('button', {name: 'End call'}).click();
    await expect(bob.getByText('Call ended.')).toBeVisible();
    await expect(alice.getByText('Call ended.')).toBeVisible();
    await alice.screenshot({path: testInfo.outputPath('direct-call-ended-light-mobile.png'), fullPage: false});
  } finally {
    await Promise.allSettled([aliceContext.close(), bobContext.close()]);
  }
});

test('register, create conversation, and deliver a message', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const aliceEmail = uniqueEmail('alice');
  const bobEmail = uniqueEmail('bob');
  const charlieEmail = uniqueEmail('charlie');
  const desktop = { viewport: { width: 2560, height: 1440 } };
  const aliceContext = await browser.newContext(desktop);
  const bobContext = await browser.newContext(desktop);
  const charlieContext = await browser.newContext(desktop);
  await aliceContext.grantPermissions(['microphone'], {origin: 'https://chat.localhost'});
  await bobContext.grantPermissions(['microphone'], {origin: 'https://chat.localhost'});
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const charlie = await charlieContext.newPage();

  try {
   await register(alice, aliceEmail, 'Alice');
   await register(bob, bobEmail, 'Bob');
   await register(charlie, charlieEmail, 'Charlie');
   await Promise.all([waitForLiveConnection(alice), waitForLiveConnection(bob), waitForLiveConnection(charlie)]);
  await expect(alice.getByRole('button', { name: 'Account menu' })).toBeVisible();
  await expect(alice.locator('.conversation-rail')).toBeVisible();
  await expect(alice.getByText(/is typing/)).not.toBeVisible();

   await alice.getByPlaceholder('Name or email').fill(bobEmail);
   await expect(alice.getByText(bobEmail)).toBeVisible();
   await alice.getByText(bobEmail).click();
   await expect(alice.getByText('No messages yet.', {exact: true})).toBeVisible();
   // Acceptance matrix: rendered empty-message copy in light/dark at 2560, 1440, 1024, and 390px.
   for (const theme of ['light', 'dark'] as const) {
     for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 768}, {width: 390, height: 844}]) {
       await alice.setViewportSize(viewport);
       await setTheme(alice, theme);
       await assertEmptyMessageContrast(alice, theme, viewport);
       await alice.screenshot({path: testInfo.outputPath(`empty-messages-${theme}-${viewport.width}.png`), fullPage: false, timeout: 15_000});
     }
   }
   await alice.setViewportSize(desktop.viewport);
   await setTheme(alice, 'dark');
   await expect(alice.getByText('Online', { exact: true })).toBeVisible();
  await expect(alice.locator('.message-history')).toBeVisible();
  await expect(alice.getByLabel('Message composer')).toBeVisible();

  const aliceConversation = bob.locator('.person-option').filter({ hasText: 'Alice' });
  await expect(aliceConversation).toBeVisible();
  await aliceConversation.click();
  await expect(bob.getByText('Online', { exact: true })).toBeVisible();

   await alice.getByPlaceholder('Write a message…').fill('typing');
    await expect(bob.getByText('Alice is typing…')).toBeVisible();
    await expect(bob.getByText('Alice is typing…')).not.toBeVisible({ timeout: 3_000 });

   await bob.setViewportSize({width: 390, height: 844});
   await bob.getByRole('button', {name: 'Back to chats'}).click();
   await bob.setViewportSize(desktop.viewport);

      await expect(alice.getByRole('button', {name: 'Start audio call'})).toBeEnabled();
      await alice.getByRole('button', {name: 'Start audio call'}).click();
      await expect(alice.getByText('Ringing...')).toBeVisible();
      await expect(bob.getByText('Incoming audio call.')).toBeVisible();
      await expect(alice.locator('.call-panel:not(.call-panel-full) .call-collapse-button')).not.toBeVisible();
      await expect(bob.locator('.call-panel:not(.call-panel-full) .call-collapse-button')).not.toBeVisible();
      expect(await bob.locator('.call-panel').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
     await expect(bob.locator('.call-profile')).toContainText('Alice');
    await expect(bob.locator('.person-option.selected')).toContainText('Alice');
     await bob.getByRole('button', {name: 'Accept'}).click();
       await expect(alice.getByText('Audio call connected.')).toBeVisible({timeout: 10_000});
      await expect(bob.getByText('Audio call connected.')).toBeVisible({timeout: 10_000});
      await expect(bob.locator('.call-profile')).toContainText('Alice');
      await expect(bob.locator('app-call-profile')).toContainText('Alice');
      await expect(alice.locator('.call-collapse-button')).toBeVisible();
     await expect(alice.locator('.message-history')).not.toBeVisible();
     await expect(alice.locator('.composer')).not.toBeVisible();
      await expect(alice.locator('.call-profile')).toContainText('Bob');
     await expect(alice.getByLabel('Microphone input', {exact: true})).toBeVisible();
     await expect(alice.getByLabel('Speaker output', {exact: true})).toBeVisible();
       await expect(alice.getByLabel('Microphone input', {exact: true})).toBeVisible();
        await expect(alice.getByLabel('Speaker output', {exact: true})).toBeVisible();
        await expect(alice.getByLabel('Screen share quality', {exact: true})).toBeVisible();
         const qualitySelect = alice.getByLabel('Screen share quality', {exact: true});
          const qualitySelectStyle = await qualitySelect.evaluate(element => {
            const style = getComputedStyle(element);
            return {height: style.height, borderRadius: style.borderRadius};
          });
         expect(qualitySelectStyle.height).toBe('48px');
         expect(qualitySelectStyle.borderRadius).toBe('12px');
         await qualitySelect.click();
         await expect(alice.locator('.call-select-panel')).toBeVisible();
          await expect(alice.locator('.call-select-panel mat-option')).toHaveCount(4);
          await alice.waitForTimeout(250);
            const qualityPanelStyle = await alice.locator('.call-select-panel').evaluate(element => {
              const style = getComputedStyle(element);
              return {classes: element.className, background: style.backgroundColor};
            });
            await expect(alice.locator('.call-select-panel mat-option').filter({hasText: '2K · ultra'})).toBeVisible();
            expect(qualityPanelStyle.classes).toContain('call-select-panel');
           expect(qualityPanelStyle.classes).toContain('call-select-panel-dark');
           expect(qualityPanelStyle).toMatchObject({background: 'rgb(38, 57, 79)'});
           const darkQualityOption = alice.locator('.call-select-panel mat-option').nth(1);
           await expect(darkQualityOption).toHaveCSS('background-color', 'rgb(52, 87, 121)');
          await expect(darkQualityOption).toHaveCSS('color', 'rgb(241, 245, 249)');
         await alice.screenshot({path: testInfo.outputPath('call-select-open-dark.png'), fullPage: false});
          await alice.keyboard.press('Escape');
          await expect(alice.getByRole('button', {name: 'Share screen'})).toBeVisible();
          const screenAudioCheckbox = alice.getByRole('checkbox', {name: 'Share audio'});
          await expect(screenAudioCheckbox).toBeVisible();
          await screenAudioCheckbox.check();
         await alice.evaluate(() => {
           const mediaDevices = navigator.mediaDevices;
           Object.defineProperty(mediaDevices, 'getDisplayMedia', {
            configurable: true,
             value: async (options: {audio?: boolean; systemAudio?: string; windowAudio?: string}) => {
               if (options.audio !== true || options.systemAudio !== 'include' || options.windowAudio !== 'system') {
                 throw new Error('Screen-share request did not ask the browser to offer system audio');
               }
               const canvas = document.createElement('canvas');
               canvas.width = 3440;
               canvas.height = 1440;
              const context = canvas.getContext('2d');
               if (context) {
                 context.fillStyle = '#b84a3a';
                 context.fillRect(0, 0, canvas.width, canvas.height);
               }
               const stream = canvas.captureStream(5);
               const audioContext = new AudioContext();
               const destination = audioContext.createMediaStreamDestination();
               const audioTrack = destination.stream.getAudioTracks()[0];
               if (audioTrack) stream.addTrack(audioTrack);
               const timer = window.setInterval(() => {
                if (!context) return;
                context.fillStyle = '#b84a3a';
                context.fillRect(0, 0, canvas.width, canvas.height);
              }, 200);
              stream.getVideoTracks()[0]?.addEventListener('ended', () => window.clearInterval(timer));
              return stream;
            },
          });
        });
        await alice.getByRole('button', {name: 'Share screen'}).click();
        await expect(alice.locator('.call-screen-stage')).toBeVisible();
        await expect(alice.locator('.call-sharing-indicator')).toContainText('Your screen is being shared with Bob');
        await expect(bob.locator('.call-sharing-indicator')).toContainText('Alice is sharing their screen with you');
        await expect(alice.locator('.call-screen-main')).toBeVisible();
        await expect(alice.locator('.call-screen-main')).toHaveJSProperty('paused', false);
        await expect(bob.locator('.call-screen-stage')).toBeVisible({timeout: 10_000});
        await expect(bob.locator('.call-screen-remote')).toBeVisible({timeout: 10_000});
        expect(await bob.locator('.call-screen-remote').evaluate(element => {
          const video = element as HTMLVideoElement;
          return video.srcObject?.active === true && video.muted;
        })).toBeTruthy();
          await expect.poll(async () => bob.locator('.call-screen-remote').evaluate(element => {
            const video = element as HTMLVideoElement;
            return !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
          }), {timeout: 10_000}).toBeTruthy();
          await expect.poll(async () => bob.locator('.call-screen-remote').evaluate(element => {
            const video = element as HTMLVideoElement;
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            const context = canvas.getContext('2d');
            if (!context) return false;
            context.drawImage(video, 0, 0, 1, 1);
            const pixel = context.getImageData(0, 0, 1, 1).data;
            return pixel[0] > 100 && pixel[0] > pixel[2] + 40;
          }), {timeout: 10_000}).toBeTruthy();
         const remoteScreenGeometry = await bob.locator('.call-screen-stage').evaluate(stage => {
           const video = stage.querySelector<HTMLVideoElement>('.call-screen-remote');
           if (!video) return undefined;
           const stageRect = stage.getBoundingClientRect();
           const videoRect = video.getBoundingClientRect();
           return {
              stage: {top: stageRect.top, bottom: stageRect.bottom, left: stageRect.left, width: stageRect.width, height: stageRect.height},
              video: {top: videoRect.top, bottom: videoRect.bottom, left: videoRect.left, right: videoRect.right, width: videoRect.width, height: videoRect.height},
              stageScrollHeight: stage.scrollHeight,
              stageClientHeight: stage.clientHeight,
              stageScrollWidth: stage.scrollWidth,
              stageClientWidth: stage.clientWidth,
              documentScrollWidth: document.documentElement.scrollWidth,
              documentClientWidth: document.documentElement.clientWidth,
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
              videoPixel: (() => {
                const canvas = document.createElement('canvas');
                canvas.width = 1;
                canvas.height = 1;
                const context = canvas.getContext('2d');
                if (!context) return undefined;
                context.drawImage(video, 0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data];
              })(),
            };
         });
         if (!remoteScreenGeometry) throw new Error('Remote screen geometry was not available');
          expect(remoteScreenGeometry.video.top).toBeGreaterThanOrEqual(remoteScreenGeometry.stage.top - 1);
          expect(remoteScreenGeometry.video.bottom).toBeLessThanOrEqual(remoteScreenGeometry.stage.bottom + 1);
          expect(remoteScreenGeometry.video.left).toBeGreaterThanOrEqual(remoteScreenGeometry.stage.left - 1);
          expect(remoteScreenGeometry.video.right).toBeLessThanOrEqual(remoteScreenGeometry.stage.left + remoteScreenGeometry.stage.width + 1);
          expect(remoteScreenGeometry.stageScrollHeight).toBeLessThanOrEqual(remoteScreenGeometry.stageClientHeight + 1);
          expect(remoteScreenGeometry.stageScrollWidth).toBeLessThanOrEqual(remoteScreenGeometry.stageClientWidth + 1);
          expect(remoteScreenGeometry.documentScrollWidth).toBeLessThanOrEqual(remoteScreenGeometry.documentClientWidth + 1);
          expect(remoteScreenGeometry.videoPixel?.[0]).toBeGreaterThan(100);
          expect(remoteScreenGeometry.videoPixel?.[0]).toBeGreaterThan((remoteScreenGeometry.videoPixel?.[2] ?? 0) + 40);
         await expect(alice.getByRole('button', {name: 'Expand shared screen'})).toBeVisible();
        await alice.getByRole('button', {name: 'Expand shared screen'}).click();
        await expect(alice.getByRole('button', {name: 'Exit fullscreen'})).toBeVisible();
        expect(await alice.locator('.call-screen-stage').evaluate(element => document.fullscreenElement === element)).toBeTruthy();
        await alice.screenshot({path: testInfo.outputPath('call-screen-share-fullscreen-dark.png'), fullPage: false});
        await alice.getByRole('button', {name: 'Exit fullscreen'}).click();
        await alice.getByRole('button', {name: 'Stop sharing'}).click();
        await expect(alice.locator('.call-screen-stage')).not.toBeVisible();
        await expect(bob.locator('.call-screen-stage')).not.toBeVisible({timeout: 5_000});
        await expect(alice.locator('.call-sharing-indicator')).not.toBeVisible();
         await expect(bob.locator('.call-sharing-indicator')).not.toBeVisible();
         await alice.getByRole('button', {name: 'Share screen'}).click();
         await expect(alice.locator('.call-screen-stage')).toBeVisible();
         await expect(screenAudioCheckbox).toBeChecked();
         await expect(screenAudioCheckbox).toBeDisabled();
         await expect(bob.locator('.call-screen-stage')).toBeVisible({timeout: 10_000});
         await expect(bob.locator('.call-screen-remote')).toBeVisible({timeout: 10_000});
         expect(await bob.locator('.call-screen-remote').evaluate(element => {
           const video = element as HTMLVideoElement;
           return video.srcObject?.active === true && video.muted;
         })).toBeTruthy();
         await expect.poll(async () => bob.locator('.call-screen-remote').evaluate(element => {
           const video = element as HTMLVideoElement;
           return !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
         }), {timeout: 10_000}).toBeTruthy();
         await alice.getByRole('button', {name: 'Stop sharing'}).click();
         await expect(bob.locator('.call-screen-stage')).not.toBeVisible({timeout: 5_000});
         await alice.getByRole('button', {name: 'Share screen'}).click();
         await expect(bob.locator('.call-screen-remote')).toBeVisible({timeout: 10_000});
          await expect.poll(async () => bob.locator('.call-screen-remote').evaluate(element => {
            const video = element as HTMLVideoElement;
            return video.srcObject?.active === true && !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
          }), {timeout: 10_000}).toBeTruthy();
          await expect.poll(async () => bob.locator('.call-screen-remote').evaluate(element => {
            const video = element as HTMLVideoElement;
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            const context = canvas.getContext('2d');
            if (!context) return false;
            context.drawImage(video, 0, 0, 1, 1);
            const pixel = context.getImageData(0, 0, 1, 1).data;
            return pixel[0] > 100 && pixel[0] > pixel[2] + 40;
          }), {timeout: 10_000}).toBeTruthy();
         await bob.screenshot({path: testInfo.outputPath('call-screen-share-restarted-remote-dark.png'), fullPage: false});
         const desktopCallControls = [
           alice.getByLabel('Microphone input', {exact: true}),
           alice.getByLabel('Speaker output', {exact: true}),
           alice.getByLabel('Screen share quality', {exact: true}),
           alice.getByRole('button', {name: 'Stop sharing'}),
         ];
        const desktopControlBoxes = await Promise.all(desktopCallControls.map(control => control.boundingBox()));
        const desktopControlHeights = desktopControlBoxes.filter((box): box is NonNullable<typeof box> => Boolean(box)).map(box => box.height);
        expect(desktopControlHeights.length).toBe(desktopCallControls.length);
         expect(Math.max(...desktopControlHeights) - Math.min(...desktopControlHeights)).toBeLessThanOrEqual(2);
          const desktopContent = alice.locator('.call-panel-full .call-card-content');
          const desktopContentMetrics = await desktopContent.evaluate(element => ({scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight}));
           expect(desktopContentMetrics.scrollWidth).toBeLessThanOrEqual(desktopContentMetrics.clientWidth + 1);
            await expect(alice.getByText('Share audio', {exact: true})).toBeVisible();
            const desktopAudioOption = alice.locator('.screen-share-audio-option');
            await desktopAudioOption.scrollIntoViewIfNeeded();
            const desktopAudioBox = await alice.locator('.screen-share-audio-option').boundingBox();
            const desktopContentBox = await desktopContent.boundingBox();
            const desktopActionsBox = await alice.locator('.call-panel-full .call-actions').boundingBox();
            if (!desktopAudioBox || !desktopContentBox || !desktopActionsBox) throw new Error('Desktop share-audio option or call actions were not visible');
            expect(desktopAudioBox.y).toBeGreaterThanOrEqual(desktopContentBox.y - 1);
            expect(desktopAudioBox.y + desktopAudioBox.height).toBeLessThanOrEqual(desktopContentBox.y + desktopContentBox.height + 1);
            expect(desktopAudioBox.y + desktopAudioBox.height).toBeLessThanOrEqual(desktopActionsBox.y + 1);
          for (const control of desktopCallControls.slice(2, 3)) {
            await control.scrollIntoViewIfNeeded();
            const controlBox = await control.boundingBox();
            const contentBox = await desktopContent.boundingBox();
            if (!controlBox || !contentBox || controlBox.y < contentBox.y - 1 || controlBox.y + controlBox.height > contentBox.y + contentBox.height + 1) {
              throw new Error('Desktop screen-quality control was clipped by the call content surface');
            }
          }
          const desktopShareBox = await alice.getByRole('button', {name: 'Stop sharing'}).boundingBox();
          if (!desktopShareBox || !desktopActionsBox) throw new Error('Desktop sticky call actions were not rendered');
          expect(desktopShareBox.y).toBeGreaterThanOrEqual(desktopActionsBox.y - 1);
          expect(desktopShareBox.y + desktopShareBox.height).toBeLessThanOrEqual(desktopActionsBox.y + desktopActionsBox.height + 1);
        await expect(alice.getByRole('button', {name: 'Expand shared screen'})).toBeVisible();
        await expect(alice.locator('.call-diagnostics')).not.toBeAttached();
       await expect(alice.locator('.call-audio-diagnostics')).not.toBeAttached();
       await expect(alice.locator('audio')).toHaveJSProperty('paused', false);
       await expect(bob.locator('audio')).toHaveJSProperty('paused', false);
        await expect(alice.locator('.call-duration')).toBeVisible();
        expect(await alice.locator('.call-panel').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
        await alice.screenshot({path: testInfo.outputPath('call-active-dark.png'), fullPage: false});
       await bob.getByRole('button', {name: 'Minimize call'}).click();
       const incomingDuringCall = `incoming-during-call-${Date.now()}`;
      await bob.getByPlaceholder('Write a message…').fill(incomingDuringCall);
      await bob.getByRole('button', {name: 'Send message'}).click();
      await expect(bob.getByText(incomingDuringCall)).toBeVisible();
      await expect(alice.locator('.person-option').filter({hasText: 'Bob'}).locator('.unread-count')).toHaveText('1');
        await alice.getByPlaceholder('Name or email').fill(charlieEmail);
        await expect(alice.getByText(charlieEmail)).toBeVisible();
        await alice.getByText(charlieEmail).click();
        await expect(alice.locator('.call-panel-full')).not.toBeVisible();
        await expect(alice.getByRole('heading', {name: 'Charlie'})).toBeVisible();
        await expect(alice.locator('.chat-presence')).toContainText('Online');
        await expect(alice.getByPlaceholder('Write a message…')).toBeVisible();
        await alice.getByPlaceholder('Write a message…').fill('');
        await alice.screenshot({path: testInfo.outputPath('call-minimized-other-chat.png'), fullPage: false});
        await expect(alice.locator('.call-minimized-banner-chat .call-minimized-sharing-label')).toHaveText('Sharing screen · ');
      await expect(alice.locator('.person-option').filter({hasText: 'Bob'}).locator('.unread-count')).not.toBeVisible();
      await expect(bob.getByText(incomingDuringCall).locator('xpath=ancestor::article').getByRole('img', {name: 'Read by peer'})).toBeVisible({timeout: 5_000});
      await alice.getByRole('button', {name: 'Return to call with Bob'}).click();
      await bob.getByRole('button', {name: 'Return to call with Alice'}).click();
      await alice.setViewportSize({width: 390, height: 844});
      await expect(alice.locator('.call-duration')).not.toHaveText('00:00', {timeout: 3_000});
      await alice.getByRole('button', {name: 'Minimize call'}).click();
      await expect(alice.locator('.call-panel-full')).not.toBeVisible();
      await expect(alice.getByPlaceholder('Write a message…')).toBeVisible();
      await expect(alice.getByRole('button', {name: 'Return to call with Bob'})).toBeVisible();
      const duringCallMessage = `during-call-${Date.now()}`;
      await alice.getByPlaceholder('Write a message…').fill(duringCallMessage);
      await alice.getByRole('button', {name: 'Send message'}).click();
      await expect(alice.getByText(duringCallMessage)).toBeVisible();
      await alice.getByRole('button', {name: 'Return to call with Bob'}).click();
      await expect(alice.locator('.call-panel-full')).toBeVisible();
      await alice.getByRole('button', {name: 'Minimize call'}).click();
      await alice.getByRole('button', {name: 'Back to chats'}).click();
      await expect(alice.locator('.conversation-rail .call-minimized-banner')).toBeVisible();
      await alice.locator('.conversation-rail').getByRole('button', {name: 'Return to call with Bob'}).click();
      await expect(alice.locator('.call-panel-full')).toBeVisible();
       await expect(alice.getByRole('button', {name: 'Mute microphone'})).toBeVisible();
     await expect(alice.getByRole('button', {name: 'End call'})).toBeVisible();
      const mobileMuteBox = await alice.getByRole('button', {name: 'Mute microphone'}).boundingBox();
     const mobileEndCallBox = await alice.getByRole('button', {name: 'End call'}).boundingBox();
      if (!mobileMuteBox || !mobileEndCallBox) {
        throw new Error('Mobile call controls bounds were not available');
      }
      expect(mobileEndCallBox.y).toBeGreaterThan(600);
      expect(mobileMuteBox.y + mobileMuteBox.height).toBeLessThanOrEqual(844);
      expect(mobileEndCallBox.y + mobileEndCallBox.height).toBeLessThanOrEqual(844);
       const mobileContent = alice.locator('.call-panel-full .call-card-content');
       expect(await mobileContent.evaluate(element => {
         const children = Array.from(element.children);
         const contentBottom = children.reduce((bottom, child) => Math.max(bottom, child.offsetTop + child.offsetHeight), 0);
         return element.scrollHeight - contentBottom;
       })).toBeLessThanOrEqual(2);
      const darkThemeColors = await callThemeColors(alice);
    expect(darkThemeColors.panel).not.toBe(darkThemeColors.text);
    expect(darkThemeColors.panel).not.toBe(darkThemeColors.control);
    expect(darkThemeColors.panel).not.toBe(darkThemeColors.controlBorder);
    expect(darkThemeColors.panel).not.toBe(darkThemeColors.icon);
    expect(darkThemeColors.scrollTrack).not.toBe(darkThemeColors.scrollThumb);
    await alice.getByRole('button', {name: 'Account menu'}).click();
    await alice.getByRole('menuitem', {name: 'Switch to light theme'}).click();
       await expect(alice.locator('html')).toHaveClass(/light-theme/);
       const lightThemeColors = await callThemeColors(alice);
    expect(lightThemeColors.panel).not.toBe(lightThemeColors.text);
    expect(lightThemeColors.panel).not.toBe(lightThemeColors.control);
    expect(lightThemeColors.panel).not.toBe(lightThemeColors.controlBorder);
     expect(lightThemeColors.panel).not.toBe(lightThemeColors.icon);
     expect(lightThemeColors.scrollTrack).not.toBe(lightThemeColors.scrollThumb);
      expect(lightThemeColors.panel).not.toBe(darkThemeColors.panel);
      expect(lightThemeColors.card).not.toBe(darkThemeColors.card);
      expect(lightThemeColors.card).not.toBe(lightThemeColors.cardText);
      expect(lightThemeColors.action).toBe('rgb(246, 248, 252)');
      expect(lightThemeColors.actionText).toBe('rgb(23, 32, 51)');
      expect(lightThemeColors.device).toBe('rgb(255, 255, 255)');
      expect(lightThemeColors.scrollThumb).not.toBe(darkThemeColors.scrollThumb);
       await alice.locator('.cdk-overlay-backdrop').click({position: {x: 1, y: 1}});
       await expect(alice.getByRole('menuitem', {name: 'Switch to light theme'})).not.toBeVisible();
       await alice.waitForTimeout(250);
       await qualitySelect.click();
       await expect(alice.locator('.call-select-panel')).toBeVisible();
       await expect(alice.locator('.call-select-panel')).toHaveClass(/call-select-panel-light/);
       await expect(alice.locator('.call-select-panel')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
       const lightQualityOption = alice.locator('.call-select-panel mat-option').nth(1);
       await expect(lightQualityOption).toHaveCSS('background-color', 'rgb(220, 234, 250)');
       await expect(lightQualityOption).toHaveCSS('color', 'rgb(23, 32, 51)');
       await alice.screenshot({path: testInfo.outputPath('call-select-open-light.png'), fullPage: false});
       await alice.keyboard.press('Escape');
        await alice.screenshot({path: testInfo.outputPath('call-active-light.png'), fullPage: false});
       await alice.getByRole('button', {name: 'Expand shared screen'}).click();
       await expect(alice.getByRole('button', {name: 'Exit fullscreen'})).toBeVisible();
       expect(await alice.locator('.call-screen-stage').evaluate(element => document.fullscreenElement === element)).toBeTruthy();
       await alice.screenshot({path: testInfo.outputPath('call-screen-share-fullscreen-light.png'), fullPage: false});
       await alice.getByRole('button', {name: 'Exit fullscreen'}).click();
     await alice.setViewportSize({width: 1440, height: 900});
     const callCard = alice.locator('.call-panel-full .call-card');
     const callPanel = alice.locator('.call-panel-full');
     const endCall = alice.getByRole('button', {name: 'End call'});
     const cardBox = await callCard.boundingBox();
      const panelBox = await callPanel.boundingBox();
      const endCallBox = await endCall.boundingBox();
      if (!cardBox || !panelBox || !endCallBox) {
        throw new Error('Active call surface bounds were not available');
      }
      expect(cardBox.y).toBeGreaterThanOrEqual(panelBox.y);
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
      expect(endCallBox.x + endCallBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
      expect(endCallBox.y + endCallBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1);
      await alice.setViewportSize({width: 1024, height: 900});
      const mediumCardBox = await callCard.boundingBox();
      const mediumPanelBox = await callPanel.boundingBox();
      if (!mediumCardBox || !mediumPanelBox) {
        throw new Error('Medium call surface bounds were not available');
      }
      expect(mediumCardBox.y).toBeGreaterThanOrEqual(mediumPanelBox.y);
      expect(mediumCardBox.x + mediumCardBox.width).toBeLessThanOrEqual(mediumPanelBox.x + mediumPanelBox.width + 1);
      expect(mediumCardBox.y + mediumCardBox.height).toBeLessThanOrEqual(mediumPanelBox.y + mediumPanelBox.height + 1);
      expect(await callPanel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
      const meters = alice.locator('.call-panel-full .call-meter');
      for (let index = 0; index < await meters.count(); index += 1) {
        const meterBox = await meters.nth(index).boundingBox();
        if (!meterBox) {
          throw new Error('Medium call meter bounds were not available');
        }
        expect(meterBox.x + meterBox.width).toBeLessThanOrEqual(mediumCardBox.x + mediumCardBox.width + 1);
      }
      await alice.setViewportSize({width: 390, height: 844});
      await expect(callCard).toBeVisible();
      const mobileCardBox = await callCard.boundingBox();
      const mobilePanelBox = await callPanel.boundingBox();
      const mobileCollapseBox = await alice.getByRole('button', {name: 'Minimize call'}).boundingBox();
      const mobileProfileBox = await alice.locator('.call-panel-full .call-profile').boundingBox();
      const mobileContentBox = await alice.locator('.call-panel-full .call-card-content').boundingBox();
      if (!mobileCardBox || !mobilePanelBox) {
        throw new Error('Mobile call surface bounds were not available');
      }
      expect(mobileCardBox.x + mobileCardBox.width).toBeLessThanOrEqual(mobilePanelBox.x + mobilePanelBox.width + 1);
      if (!mobileCollapseBox || !mobileProfileBox || !mobileContentBox) {
        throw new Error('Mobile collapse-control bounds were not available');
       }
       expect(mobileCollapseBox.x).toBeLessThan(mobileContentBox.x);
       expect(mobileCollapseBox.y + mobileCollapseBox.height).toBeLessThanOrEqual(mobileProfileBox.y + 2);
        const mobileScreenStage = alice.locator('.call-screen-stage');
        await expect(mobileScreenStage).toBeVisible();
        await expect(alice.locator('.call-sharing-indicator')).toBeHidden();
       const mobileScreenBox = await mobileScreenStage.boundingBox();
        if (!mobileScreenBox || mobileScreenBox.x < mobilePanelBox.x || mobileScreenBox.x + mobileScreenBox.width > mobilePanelBox.x + mobilePanelBox.width + 1) {
          throw new Error('Mobile shared-screen stage escaped the call panel');
        }
        const mobileViewportMetrics = await alice.evaluate(() => ({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth}));
        expect(mobileViewportMetrics.scrollWidth).toBeLessThanOrEqual(mobileViewportMetrics.clientWidth + 1);
        const mobileCallControls = [
          alice.getByLabel('Microphone input', {exact: true}),
          alice.getByLabel('Speaker output', {exact: true}),
          alice.getByLabel('Screen share quality', {exact: true}),
          alice.getByRole('button', {name: 'Stop sharing'}),
        ];
       const mobileControlBoxes = await Promise.all(mobileCallControls.map(control => control.boundingBox()));
        const mobileControlHeights = mobileControlBoxes.filter((box): box is NonNullable<typeof box> => Boolean(box)).map(box => box.height);
        expect(mobileControlHeights.length).toBe(mobileCallControls.length);
          expect(Math.max(...mobileControlHeights) - Math.min(...mobileControlHeights)).toBeLessThanOrEqual(2);
          const mobileStopShareBox = await alice.getByRole('button', {name: 'Stop sharing'}).boundingBox();
          if (!mobileStopShareBox) throw new Error('Mobile stop-sharing bounds were not available');
          await expect(alice.getByText('Share audio', {exact: true})).toBeVisible();
          const mobileAudioCheckboxBox = await screenAudioCheckbox.boundingBox();
          if (!mobileAudioCheckboxBox) throw new Error('Mobile system-audio checkbox bounds were not available');
          expect(mobileAudioCheckboxBox.x + mobileAudioCheckboxBox.width).toBeLessThanOrEqual(mobilePanelBox.x + mobilePanelBox.width + 1);
          await expect(alice.getByRole('button', {name: 'Expand shared screen'})).toBeVisible();
         await alice.screenshot({path: testInfo.outputPath('call-active-mobile-light-top.png'), fullPage: false});
         const mobileStickyGeometry = await alice.locator('.call-panel-full .call-card-content').evaluate(element => {
            const content = element as HTMLElement;
            const profile = document.querySelector<HTMLElement>('.call-panel-full .call-profile');
            const devices = document.querySelector<HTMLElement>('.call-panel-full .call-devices');
            const screenTools = document.querySelector<HTMLElement>('.call-panel-full .call-screen-tools');
            const contentBox = content.getBoundingClientRect();
            const profileAtTop = profile?.getBoundingClientRect();
            content.scrollTop = content.scrollHeight;
            const profileAtEnd = profile?.getBoundingClientRect();
            const devicesAtEnd = devices?.getBoundingClientRect();
            const screenToolsAtEnd = screenTools?.getBoundingClientRect();
            return {scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, contentTop: contentBox.top, contentBottom: contentBox.bottom, profileAtTop, profileAtEnd, devicesAtEnd, screenToolsAtEnd};
          });
          expect(mobileStickyGeometry.scrollTop).toBeGreaterThan(0);
          expect(mobileStickyGeometry.scrollTop + mobileStickyGeometry.clientHeight).toBeGreaterThanOrEqual(mobileStickyGeometry.scrollHeight - 1);
          expect(Math.abs((mobileStickyGeometry.profileAtTop?.top || 0) - (mobileStickyGeometry.profileAtEnd?.top || 0))).toBeLessThanOrEqual(1);
          expect(mobileStickyGeometry.profileAtEnd?.bottom).toBeLessThanOrEqual(mobileStickyGeometry.contentTop + 1);
           expect(mobileStickyGeometry.devicesAtEnd?.bottom).toBeLessThanOrEqual(mobileStickyGeometry.contentBottom + 1);
           const mobileActionBox = await alice.locator('.call-panel-full .call-actions').boundingBox();
           const mobileShareActionBox = await alice.getByRole('button', {name: 'Stop sharing'}).boundingBox();
           const mobileMuteActionBox = await alice.getByRole('button', {name: 'Mute microphone'}).boundingBox();
           if (!mobileShareActionBox || !mobileMuteActionBox || !mobileActionBox) throw new Error('Mobile sticky call actions were not visible');
           expect(mobileMuteActionBox.y).toBeGreaterThanOrEqual(mobileActionBox.y - 1);
           expect(mobileShareActionBox.y).toBeGreaterThanOrEqual(mobileActionBox.y - 1);
           expect(mobileMuteActionBox.y + mobileMuteActionBox.height).toBeLessThanOrEqual(mobileActionBox.y + mobileActionBox.height + 1);
           expect(mobileShareActionBox.y + mobileShareActionBox.height).toBeLessThanOrEqual(mobileActionBox.y + mobileActionBox.height + 1);
           expect(mobileShareActionBox.y + mobileShareActionBox.height).toBeLessThanOrEqual(844);
          await alice.screenshot({path: testInfo.outputPath('call-active-mobile-light.png'), fullPage: false});
       await alice.getByRole('button', {name: 'Expand shared screen'}).click();
       await expect(alice.getByRole('button', {name: 'Exit fullscreen'})).toBeVisible();
       await alice.screenshot({path: testInfo.outputPath('call-screen-share-fullscreen-mobile-light.png'), fullPage: false});
       await alice.getByRole('button', {name: 'Exit fullscreen'}).click();
       await alice.setViewportSize(desktop.viewport);
     await alice.getByRole('button', {name: 'Mute microphone'}).click();
     await expect(alice.getByRole('button', {name: 'Unmute microphone'})).toBeVisible();
    await alice.getByRole('button', {name: 'End call'}).click();
    await expect(alice.locator('.person-option').filter({hasText: 'Bob'}).locator('.unread-count')).not.toBeVisible();
    await expect(bob.getByText('Call ended.')).toBeVisible();
      await expect(bob.locator('.call-diagnostics')).not.toBeAttached();
   await bob.locator('.person-option').filter({hasText: 'Alice'}).click();

   await bob.goto('/profile');
  await expect(bob.getByRole('heading', {name: 'Profile'})).toBeVisible();
  await alice.getByRole('button', {name: 'Start audio call'}).click();
  const offlineCallNotice = alice.getByText('Call unavailable: recipient is offline', {exact: true});
  await expect(offlineCallNotice).toHaveCount(1);
  await expect(offlineCallNotice).toBeVisible();
  await expect(offlineCallNotice).not.toBeVisible({timeout: 7_000});
  await bob.goto('/home');
  await expect(bob.getByRole('heading', {name: 'Chats'})).toBeVisible();
  await bob.getByPlaceholder('Name or email').fill(aliceEmail);
  const restoredBobSearchResult = bob.locator('.search-result').filter({hasText: aliceEmail});
  await expect(restoredBobSearchResult).toBeVisible();
  await restoredBobSearchResult.click();
  await expect(bob.getByPlaceholder('Write a message…')).toBeEnabled({timeout: 10_000});

   const messages = [`hello-${Date.now()}`, `follow-up-${Date.now()}`];
  const started = Date.now();
  await alice.getByPlaceholder('Write a message…').fill(messages[0]);
  await expect(alice.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await alice.getByPlaceholder('Write a message…').press('Enter');
   await expect(alice.getByText(messages[0])).toBeVisible({ timeout: 5_000 });
   await expect(bob.getByText(messages[0])).toBeVisible({ timeout: 5_000 });
   await expect(alice.getByText(messages[0]).locator('xpath=ancestor::article').locator('time')).toContainText('Today');
   await expect(alice.getByRole('img', {name: 'Read by peer'})).toBeVisible({ timeout: 5_000 });

  await alice.getByPlaceholder('Write a message…').fill(messages[1]);
  await expect(alice.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await alice.getByRole('button', { name: 'Send message' }).click();
  await expect(alice.getByText(messages[1])).toBeVisible({ timeout: 5_000 });
  await expect(bob.getByText(messages[1])).toBeVisible({ timeout: 5_000 });

  const reply = `reply-${Date.now()}`;
  await alice.setViewportSize({ width: 390, height: 844 });
  await alice.getByRole('button', { name: 'Back to chats' }).click();
  await alice.setViewportSize(desktop.viewport);
  await bob.getByPlaceholder('Write a message…').fill(reply);
  await bob.getByRole('button', { name: 'Send message' }).click();
  const aliceConversationAfterReply = alice.locator('.person-option').filter({ hasText: 'Bob' });
  await expect(aliceConversationAfterReply.locator('.unread-count')).toHaveText('1', { timeout: 5_000 });

  await alice.reload();
  const restoredAliceConversation = alice.locator('.person-option').filter({ hasText: 'Bob' });
  await expect(restoredAliceConversation.locator('.unread-count')).toHaveText('1');
  await restoredAliceConversation.click();
  await expect(alice.getByRole('heading', { name: 'Bob' })).toBeVisible();
  await expect(alice.getByText(messages[0])).toBeVisible();
  await expect(alice.getByText(reply)).toBeVisible();
  await expect(alice.locator('.unread-count')).not.toBeVisible();
  await expect(alice.getByText(messages[0]).locator('xpath=ancestor::article')).toHaveClass(/message-own/);
  await expect(alice.getByText(reply).locator('xpath=ancestor::article')).not.toHaveClass(/message-own/);
  const shortMessageBox = await alice.getByText(messages[0]).locator('xpath=ancestor::article').boundingBox();
  expect(shortMessageBox?.width).toBeGreaterThanOrEqual(180);
  expect(shortMessageBox?.height).toBeGreaterThanOrEqual(64);
  expect(Date.now() - started).toBeLessThan(5_000);
  const longMessage = `long-message-${'x'.repeat(4_000)}`;
  await alice.getByPlaceholder('Write a message…').fill(longMessage);
  await alice.getByRole('button', { name: 'Send message' }).click();
  const longMessageBubble = alice.locator('.message-bubble').filter({hasText: 'long-message-'});
  await expect(longMessageBubble).toBeVisible({timeout: 5_000});
  const longMessageBox = await longMessageBubble.boundingBox();
  expect(longMessageBox?.width).toBeLessThanOrEqual(680);
  expect(longMessageBox?.height).toBeLessThanOrEqual(240);
  const messageColumn = await alice.locator('.message-list').boundingBox();
  expect(messageColumn?.width).toBeLessThanOrEqual(980);

  } finally {
    await Promise.allSettled([aliceContext.close(), bobContext.close(), charlieContext.close()]);
  }
});

test('notifies and sounds a background conversation without duplicating the visible message', async ({browser}) => {
  const aliceEmail = uniqueEmail('notifications-alice');
  const bobEmail = uniqueEmail('notifications-bob');
  const aliceContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const bobContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  await installNotificationStubs(bob);

  try {
     await register(alice, aliceEmail, 'Alice');
     await register(bob, bobEmail, 'Bob');
     await Promise.all([waitForLiveConnection(alice), waitForLiveConnection(bob)]);

     await alice.getByPlaceholder('Name or email').fill(bobEmail);
     const aliceSearchResult = alice.locator('.search-result').filter({hasText: bobEmail});
     await expect(aliceSearchResult).toBeVisible();
      await aliceSearchResult.click();
      await expect(alice.getByPlaceholder('Write a message…')).toBeEnabled({timeout: 10_000});
      await expect(alice.getByText('No messages yet.', {exact: true})).toBeVisible();

     await bob.getByPlaceholder('Name or email').fill(aliceEmail);
     const bobSearchResult = bob.locator('.search-result').filter({hasText: aliceEmail});
     await expect(bobSearchResult).toBeVisible();
     await bobSearchResult.click();
    const bobConversation = bob.locator('.person-option').filter({hasText: 'Alice'});
    await expect(bobConversation).toBeVisible();
     await bobConversation.click();
     await expect(bob.getByPlaceholder('Write a message…')).toBeEnabled();
     await expect(bob.getByText('No messages yet.', {exact: true})).toBeVisible();

    await bob.getByRole('button', {name: 'Account menu'}).click();
    await bob.getByRole('menuitem', {name: 'Profile'}).click();
    const notificationMode = bob.getByRole('radio', {name: /Notifications and sounds/});
    await notificationMode.click();
    await expect(notificationMode).toHaveAttribute('aria-checked', 'true');
    expect(await bob.evaluate(() => (window as Window & {__zweiAudioState: {tones: number; unlocks: number}}).__zweiAudioState.unlocks)).toBe(1);
    await bob.getByRole('link', {name: 'Back to chats'}).click();

    await bob.evaluate(() => Object.defineProperty(document, 'hasFocus', {configurable: true, value: () => true}));
    const visibleMessage = `visible-${Date.now()}`;
    await alice.getByPlaceholder('Write a message…').fill(visibleMessage);
    await alice.getByPlaceholder('Write a message…').press('Enter');
    await expect(bob.getByText(visibleMessage)).toBeVisible({timeout: 10_000});
    expect(await bob.evaluate(() => (window as Window & {__zweiNotificationRecords: BrowserNotificationRecord[]}).__zweiNotificationRecords)).toEqual([]);

    await bob.evaluate(() => Object.defineProperty(document, 'hasFocus', {configurable: true, value: () => false}));
    const backgroundMessage = `background-${Date.now()}`;
    await alice.getByPlaceholder('Write a message…').fill(backgroundMessage);
    await alice.getByPlaceholder('Write a message…').press('Enter');
    await expect(bob.getByText(backgroundMessage)).toBeVisible({timeout: 10_000});
    await expect.poll(async () => bob.evaluate(() => (window as Window & {__zweiNotificationRecords: BrowserNotificationRecord[]}).__zweiNotificationRecords.length)).toBe(1);
    expect(await bob.evaluate(() => (window as Window & {__zweiNotificationRecords: BrowserNotificationRecord[]}).__zweiNotificationRecords[0])).toEqual({title: 'New message', body: 'You have a new message.', tag: expect.stringMatching(/^zwei-message-/)});
    await expect.poll(async () => bob.evaluate(() => (window as Window & {__zweiAudioState: {tones: number; unlocks: number}}).__zweiAudioState.tones)).toBeGreaterThan(0);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test('replays a message sent while the recipient is offline', async ({ browser }) => {
  const aliceEmail = uniqueEmail('offline-alice');
  const bobEmail = uniqueEmail('offline-bob');
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  await register(alice, aliceEmail, 'Alice');
  await register(bob, bobEmail, 'Bob');
  await Promise.all([waitForLiveConnection(alice), waitForLiveConnection(bob)]);
  await alice.getByPlaceholder('Name or email').fill(bobEmail);
  await alice.getByText(bobEmail).click();
  await bob.getByPlaceholder('Name or email').fill(aliceEmail);
  const bobSearchResult = bob.locator('.search-result').filter({hasText: aliceEmail});
  await expect(bobSearchResult).toBeVisible();
  await bobSearchResult.click();
  await expect(bob.getByPlaceholder('Write a message…')).toBeEnabled({timeout: 10_000});

  await bob.goto('/profile');
  await expect(bob.getByRole('heading', {name: 'Profile'})).toBeVisible();
  const offlineMessage = `offline-${Date.now()}`;
  await alice.getByPlaceholder('Write a message…').fill(offlineMessage);
  await alice.getByPlaceholder('Write a message…').press('Enter');
  await expect(alice.getByText(offlineMessage)).toBeVisible();

  await bob.goto('/home');
  await expect(bob.getByPlaceholder('Write a message…')).toBeEnabled({timeout: 10_000});
  await expect(bob.getByText(offlineMessage)).toBeVisible({timeout: 10_000});

  await aliceContext.close();
  await bobContext.close();
});

test('shares read and unread state across a user\'s browser devices', async ({ browser }) => {
  const aliceEmail = uniqueEmail('global-alice');
  const bobEmail = uniqueEmail('global-bob');
  const aliceContext = await browser.newContext();
  const aliceSecondContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const aliceSecond = await aliceSecondContext.newPage();
  const bob = await bobContext.newPage();

  await register(alice, aliceEmail, 'Alice');
  await register(bob, bobEmail, 'Bob');
  await Promise.all([waitForLiveConnection(alice), waitForLiveConnection(bob)]);
  await alice.getByPlaceholder('Name or email').fill(bobEmail);
  await alice.getByText(bobEmail).click();
  await bob.getByPlaceholder('Name or email').fill(aliceEmail);
  const bobSearchResult = bob.locator('.search-result').filter({hasText: aliceEmail});
  await expect(bobSearchResult).toBeVisible();
  await bobSearchResult.click();
  await expect(bob.getByPlaceholder('Write a message…')).toBeEnabled({timeout: 10_000});

  await aliceSecond.goto('/login');
  await login(aliceSecond, aliceEmail);
  const secondConversation = aliceSecond.locator('.person-option').filter({hasText: 'Bob'});
  await expect(secondConversation).toBeVisible();
  await bob.locator('.person-option').filter({hasText: 'Alice'}).click();
  const message = `global-read-${Date.now()}`;
  await bob.getByPlaceholder('Write a message…').fill(message);
  await bob.getByRole('button', {name: 'Send message'}).click();
  await expect(alice.getByText(message)).toBeVisible({timeout: 5_000});
  await aliceSecond.reload();
  await expect(aliceSecond.locator('.person-option').filter({hasText: 'Bob'})).toBeVisible();
  await expect(aliceSecond.locator('.person-option').filter({hasText: 'Bob'}).locator('.unread-count')).not.toBeVisible({timeout: 5_000});

  await aliceContext.close();
  await aliceSecondContext.close();
  await bobContext.close();
});

test('measures Home rail and composer text contrast in light and dark mobile themes', async ({browser}, testInfo) => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();

  try {
    await register(page, uniqueEmail('mobile-text-contrast'), 'Contrast');
    await waitForLiveConnection(page);
    const allChats = page.locator('.rail-label > span').first();
    const searchInput = page.locator('.search-field input');
    const composer = page.locator('.composer textarea');
    await expect(allChats).toHaveText('All chats');
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveAttribute('placeholder', 'Choose a chat to start messaging');

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await searchInput.focus();
      await expect(searchInput).toBeFocused();
      const metrics = {
        allChats: await measureRenderedTextContrastAtSurface(allChats),
        searchPlaceholder: await measureRenderedTextContrastAtSurface(searchInput, '::placeholder'),
        composerPlaceholder: await measureRenderedTextContrastAtSurface(composer, '::placeholder'),
      };
      console.log(`HOME_MOBILE_TEXT_CONTRAST ${JSON.stringify({theme, viewport: {width: 390, height: 844}, metrics})}`);
      expect(metrics.allChats.ratio, `${theme} All chats contrast: ${JSON.stringify(metrics.allChats)}`).toBeGreaterThanOrEqual(4.5);
      expect(metrics.searchPlaceholder.opacity, `${theme} focused search placeholder opacity`).toBeGreaterThan(0);
      expect(metrics.searchPlaceholder.ratio, `${theme} focused Name or email contrast: ${JSON.stringify(metrics.searchPlaceholder)}`).toBeGreaterThanOrEqual(4.5);
      expect(metrics.composerPlaceholder.opacity, `${theme} disabled composer placeholder opacity`).toBeGreaterThan(0);
      expect(metrics.composerPlaceholder.ratio, `${theme} empty composer placeholder contrast: ${JSON.stringify(metrics.composerPlaceholder)}`).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({path: testInfo.outputPath(`home-mobile-empty-text-contrast-${theme}-390.png`), fullPage: false});
      await searchInput.blur();
    }
  } finally {
    await context.close();
  }
});

test('group HTTP surface enforces ownership and membership visibility', async ({ browser }) => {
  const ownerEmail = uniqueEmail('group-owner');
  const memberEmail = uniqueEmail('group-member');
  const ownerContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const memberContext = await browser.newContext({viewport: {width: 390, height: 844}});
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();

  try {
    await register(owner, ownerEmail, 'Group owner');
    await register(member, memberEmail, 'Group member');
    const ownerLogin = await ownerContext.request.post(`${adminBase}/api/auth/login`, {data: {email: ownerEmail, password, device_id: `group-owner-${Date.now()}`, device_name: 'E2E'}});
    const memberLogin = await memberContext.request.post(`${adminBase}/api/auth/login`, {data: {email: memberEmail, password, device_id: `group-member-${Date.now()}`, device_name: 'E2E'}});
    const ownerToken = (await ownerLogin.json() as {access_token: string; token_type: string});
    const memberToken = (await memberLogin.json() as {access_token: string; token_type: string});
    const memberSearch = await ownerContext.request.get(`${chatBase}/api/chat/users/search?q=${encodeURIComponent(memberEmail)}`, {headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`}});
    expect(memberSearch.status()).toBe(200);
    const memberID = (await memberSearch.json() as Array<{id: string}>).find(item => item.id)?.id;
    expect(memberID).toBeTruthy();
    if (!memberID) throw new Error('member search did not return the active verified account');
    const createGroup = () => ownerContext.request.post(`${chatBase}/api/chat/groups`, {headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`}, data: {name: 'Launch team', member_ids: [memberID]}});
    let created = await createGroup();
    if (created.status() === 429) {
      const retryAfter = Number(created.headers()['retry-after'] ?? '60');
      await owner.waitForTimeout(Math.max(retryAfter, 1) * 1_000);
      created = await createGroup();
    }
    expect(created.status()).toBe(201);
    const group = await created.json() as {id: string; name: string; membership_revision: number; members: Array<{user_id: string; role: string}>};
    expect(group.name).toBe('Launch team');
    expect(group.members).toHaveLength(2);
    expect(group.members.find(item => item.user_id === memberID)?.role).toBe('member');
    const renameAsMember = () => memberContext.request.patch(`${chatBase}/api/chat/groups/${group.id}`, {headers: {Authorization: `${memberToken.token_type} ${memberToken.access_token}`}, data: {name: 'Not allowed'}});
    let deniedRename = await renameAsMember();
    if (deniedRename.status() === 429) {
      const retryAfter = Number(deniedRename.headers()['retry-after'] ?? '60');
      await member.waitForTimeout(Math.max(retryAfter, 1) * 1_000);
      deniedRename = await renameAsMember();
    }
    expect(deniedRename.status()).toBe(403);
    const renamed = await ownerContext.request.patch(`${chatBase}/api/chat/groups/${group.id}`, {headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`}, data: {name: 'Release team'}});
    expect(renamed.status()).toBe(200);
    expect((await renamed.json() as {name: string}).name).toBe('Release team');
    const left = await memberContext.request.post(`${chatBase}/api/chat/groups/${group.id}/leave`, {headers: {Authorization: `${memberToken.token_type} ${memberToken.access_token}`}});
    expect(left.status()).toBe(204);
    const removedProjection = await memberContext.request.get(`${chatBase}/api/chat/groups/${group.id}`, {headers: {Authorization: `${memberToken.token_type} ${memberToken.access_token}`}});
    expect(removedProjection.status()).toBe(404);
  } finally {
    await Promise.allSettled([ownerContext.close(), memberContext.close()]);
  }
});

test('manages a group through authorized UI states', async ({browser}, testInfo) => {
  test.setTimeout(180_000);
  const ownerEmail = uniqueEmail('group-ui-owner');
  const memberEmail = uniqueEmail('group-ui-member');
  const removedEmail = uniqueEmail('group-ui-removed');
  const ownerContext = await browser.newContext({viewport: {width: 2560, height: 1440}});
  const memberContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();

  try {
    await register(owner, ownerEmail, 'Owner');
    await register(member, memberEmail, 'Member');
    const removedContext = await browser.newContext();
    const removed = await removedContext.newPage();
    await register(removed, removedEmail, 'Removed');
    await removedContext.close();
    await Promise.all([waitForLiveConnection(owner), waitForLiveConnection(member)]);

    await expect(owner.getByText('Your messages, your space')).toBeVisible();
    await expect(owner.getByLabel('Message composer disabled until a conversation is selected')).toBeVisible();
    await owner.getByRole('button', {name: 'Create group'}).click();
    await owner.getByLabel('Group name').fill('Browser acceptance group');
    const createResponse = owner.waitForResponse(response => response.url().endsWith('/api/chat/groups') && response.request().method() === 'POST');
    await owner.locator('.group-create-card').getByRole('button', {name: 'Create group'}).click();
    const created = await createResponse;
    expect(created.status()).toBe(201);
    const groupID = (await created.json() as {id: string}).id;
    await expect(owner.getByRole('heading', {name: 'Browser acceptance group'})).toBeVisible();
    await expect(owner.locator('.group-members > li')).toHaveCount(1);
    const ownerOnlyRow = owner.locator('.group-members > li').filter({hasText: 'Owner'});
    await expect(ownerOnlyRow.locator('.member-actions')).toHaveCount(0);
    expect((await ownerOnlyRow.boundingBox())?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(70);
     await expect(owner.getByText('No messages yet.', {exact: true})).toBeVisible();
    await expect(owner.getByLabel('Message composer')).toBeVisible();
    for (const theme of ['dark', 'light'] as const) {
      for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
        await owner.setViewportSize(viewport);
        await setTheme(owner, theme);
        await expect(owner.locator('.group-members > li')).toHaveCount(1);
        const ownerOnlyGeometry = await ownerOnlyRow.evaluate(row => {
          const rowRect = row.getBoundingClientRect();
          const identityRect = row.querySelector('.member-identity')?.getBoundingClientRect();
          return {height: rowRect.height, top: rowRect.top, bottom: rowRect.bottom, identityBottom: identityRect?.bottom, actionCount: row.querySelectorAll('.member-action-button').length, documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth};
        });
        expect(ownerOnlyGeometry.height).toBeLessThanOrEqual(70);
        expect(ownerOnlyGeometry.identityBottom).toBeLessThanOrEqual(ownerOnlyGeometry.bottom + 1);
        expect(ownerOnlyGeometry.actionCount).toBe(0);
        expect(ownerOnlyGeometry.top).toBeGreaterThanOrEqual(0);
        expect(ownerOnlyGeometry.bottom).toBeLessThanOrEqual(viewport.height);
        expect(ownerOnlyGeometry.documentWidth).toBeLessThanOrEqual(ownerOnlyGeometry.viewportWidth + 1);
        await owner.screenshot({path: testInfo.outputPath(`group-settings-owner-only-${theme}-${viewport.width}.png`), fullPage: false});
        if (viewport.width === 390) {
          const settingsPanel = owner.locator('.group-settings-panel');
          const ownerOnlyEnd = await settingsPanel.evaluate(element => {
            const panel = element as HTMLElement;
            panel.scrollTop = panel.scrollHeight;
            const panelRect = panel.getBoundingClientRect();
            const managerRect = panel.closest<HTMLElement>('.group-manager')?.getBoundingClientRect();
            const access = panel.querySelector<HTMLElement>('.group-danger-zone');
            const accessRect = access?.getBoundingClientRect();
            const buttons = Array.from(access?.querySelectorAll<HTMLElement>('button') ?? []).map(button => {
              const rect = button.getBoundingClientRect();
              return {label: button.innerText.trim(), top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height, disabled: (button as HTMLButtonElement).disabled};
            });
            return {
              panel: {top: panelRect.top, bottom: panelRect.bottom, scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight},
              manager: managerRect ? {top: managerRect.top, bottom: managerRect.bottom, left: managerRect.left, right: managerRect.right} : undefined,
              access: accessRect ? {top: accessRect.top, bottom: accessRect.bottom} : undefined,
              buttons,
              document: {scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight},
            };
          });
          expect(ownerOnlyEnd.panel.scrollTop + ownerOnlyEnd.panel.clientHeight).toBeGreaterThanOrEqual(ownerOnlyEnd.panel.scrollHeight - 1);
          expect(ownerOnlyEnd.manager).toBeDefined();
          expect(ownerOnlyEnd.manager?.top).toBeGreaterThanOrEqual(0);
          expect(ownerOnlyEnd.manager?.bottom).toBeLessThanOrEqual(ownerOnlyEnd.document.viewportHeight + 1);
          expect(ownerOnlyEnd.manager?.left).toBeGreaterThanOrEqual(0);
          expect(ownerOnlyEnd.manager?.right).toBeLessThanOrEqual(ownerOnlyEnd.document.clientWidth + 1);
          expect(ownerOnlyEnd.access?.top).toBeGreaterThanOrEqual(ownerOnlyEnd.panel.top - 1);
          expect(ownerOnlyEnd.access?.bottom).toBeLessThanOrEqual(ownerOnlyEnd.panel.bottom + 1);
          expect(ownerOnlyEnd.buttons.map(button => button.label)).toEqual(['Leave group', 'Delete group']);
          expect(ownerOnlyEnd.buttons.every(button => !button.disabled && button.height >= 44 && button.top >= ownerOnlyEnd.panel.top - 1 && button.bottom <= ownerOnlyEnd.panel.bottom + 1 && button.bottom <= ownerOnlyEnd.document.viewportHeight + 1), JSON.stringify(ownerOnlyEnd)).toBeTruthy();
          expect(ownerOnlyEnd.document.scrollWidth).toBeLessThanOrEqual(ownerOnlyEnd.document.clientWidth + 1);
          await expect(owner.getByRole('button', {name: 'Leave group'})).toBeVisible();
          await expect(owner.getByRole('button', {name: 'Delete group'})).toBeVisible();
          await owner.screenshot({path: testInfo.outputPath(`group-settings-owner-only-${theme}-390-end.png`), fullPage: false});
          await settingsPanel.evaluate(element => { (element as HTMLElement).scrollTop = 0; });
        }
      }
    }
    await owner.setViewportSize({width: 2560, height: 1440});
    await setTheme(owner, 'dark');
    await owner.screenshot({path: testInfo.outputPath('group-selected-dark-desktop.png'), fullPage: false});
    await owner.getByRole('button', {name: 'Account menu'}).click();
    await owner.getByRole('menuitem', {name: 'Switch to light theme'}).click();
    await expect(owner.locator('html')).toHaveClass(/light-theme/);
    await owner.getByRole('button', {name: 'Create group'}).click();
    const groupCreation = owner.getByRole('heading', {name: 'Create a group'});
    await expect(groupCreation).toBeVisible();
    await expect(owner.getByLabel('Message composer')).toHaveCount(0);
    const lightGroupButton = await owner.locator('.new-group-button').evaluate(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const channel = (color: string): number[] => color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
      const luminance = (color: string): number => channel(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const background = luminance(style.backgroundColor);
      const foreground = luminance(style.color);
      return {background: style.backgroundColor, color: style.color, contrast: (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05), left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth};
    });
    expect(lightGroupButton.background).not.toBe('rgb(0, 0, 0)');
    expect(lightGroupButton.contrast).toBeGreaterThanOrEqual(4.5);
    expect(lightGroupButton.left).toBeGreaterThanOrEqual(0);
    expect(lightGroupButton.right).toBeLessThanOrEqual(lightGroupButton.viewport + 1);
    expect(lightGroupButton.scrollWidth).toBeLessThanOrEqual(lightGroupButton.viewport);
    const lightCreationSurface = await owner.locator('.group-create-card').evaluate(element => {
      const panel = element.parentElement;
      const input = element.querySelector('input');
      return {card: getComputedStyle(element).backgroundColor, panel: panel ? getComputedStyle(panel).backgroundColor : '', input: input ? getComputedStyle(input).backgroundColor : '', text: getComputedStyle(element).color};
    });
    expect(lightCreationSurface.panel).toBe('rgb(246, 248, 252)');
    expect(lightCreationSurface.card).toBe('rgb(255, 255, 255)');
    expect(lightCreationSurface.input).toBe('rgb(255, 255, 255)');
    expect(lightCreationSurface.text).toBe('rgb(23, 32, 51)');
    await owner.screenshot({path: testInfo.outputPath('group-create-light-desktop.png'), fullPage: false});
    await owner.setViewportSize({width: 390, height: 844});
    const mobileCreation = await owner.locator('.group-create-card').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return {left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth};
    });
    expect(mobileCreation.left).toBeGreaterThanOrEqual(0);
    expect(mobileCreation.right).toBeLessThanOrEqual(mobileCreation.viewport + 1);
    expect(mobileCreation.scrollWidth).toBeLessThanOrEqual(mobileCreation.viewport);
    await owner.screenshot({path: testInfo.outputPath('group-create-light-mobile.png'), fullPage: false});
    await owner.getByRole('button', {name: 'Cancel'}).click();
    await expect(owner.locator('.conversation-rail')).toBeVisible();
    await owner.setViewportSize({width: 2560, height: 1440});
    await owner.getByRole('button', {name: /Browser acceptance group/}).click();
    await expect(owner.getByRole('heading', {name: 'Browser acceptance group'})).toBeVisible();
    await owner.screenshot({path: testInfo.outputPath('group-manager-light-desktop.png'), fullPage: false});
    const firstGroupMessage = `group-message-${Date.now()}`;
    await owner.getByPlaceholder('Write a message…').fill(firstGroupMessage);
    await owner.getByRole('button', {name: 'Send message'}).click();
    await expect(owner.getByText(firstGroupMessage)).toBeVisible();

    const ownerToken = await authenticatedToken(ownerContext, ownerEmail, 'group-ui-owner');
    const memberIDs = new Map<string, string>();
    for (const email of [memberEmail, removedEmail]) memberIDs.set(email, await userID(ownerContext, ownerToken, email));
    const addMember = async (email: string): Promise<void> => {
      const id = memberIDs.get(email);
      if (!id) throw new Error(`missing member ID for ${email}`);
      const memberCount = await owner.locator('.group-members li').count();
      await owner.getByLabel('Find a person').fill(email);
      await expect(owner.getByRole('option', {name: new RegExp(email)})).toBeVisible();
      await owner.getByRole('option', {name: new RegExp(email)}).click();
      await owner.getByRole('button', {name: 'Add member'}).click();
      await expect(owner.locator('.group-members li')).toHaveCount(memberCount + 1);
    };
    await addMember(memberEmail);
    const memberPresenceSnapshots = observePresenceSnapshots(member);
    const ownerID = await currentUserID(ownerContext, ownerToken);
    await member.reload();
    await waitForLiveConnection(member);
    await expect(member.locator('.person-option').filter({hasText: 'Browser acceptance group'})).toBeVisible({timeout: 10_000});
    await member.locator('.person-option').filter({hasText: 'Browser acceptance group'}).click();
    await expect(member.getByRole('button', {name: 'Manage group'})).toHaveCount(0);
    await expect(member.locator('.group-manager')).toHaveCount(0);
    await expect.poll(() => memberPresenceSnapshots.length, {timeout: 10_000}).toBeGreaterThan(0);
    expect(memberPresenceSnapshots.some(userIDs => userIDs.includes(ownerID)), `presence snapshot peer counts: ${memberPresenceSnapshots.map(userIDs => userIDs.length).join(',')}`).toBe(true);
    await expect(member.locator('.chat-presence')).toHaveText('1 members online', {timeout: 10_000});
    await expect(member.getByText('Owner added Member to the group.', {exact: true})).toBeVisible();
    const attributedGroupMessage = `group-attribution-${Date.now()}`;
    await member.getByPlaceholder('Write a message…').fill(attributedGroupMessage);
    await member.getByRole('button', {name: 'Send message'}).click();
    const ownerMessage = owner.locator('.message-bubble').filter({hasText: attributedGroupMessage});
    await expect(ownerMessage).toBeVisible({timeout: 10_000});
    await expect(ownerMessage.locator('.message-sender')).toHaveText('Member');
    const ownerMemberRow = owner.locator('.group-members li').filter({hasText: 'Member'});
    let releaseRoleMutation = (): void => {};
    let signalRoleMutation = (): void => {};
    const roleMutationStarted = new Promise<void>(resolve => { signalRoleMutation = resolve; });
    const roleMutationGate = new Promise<void>(resolve => { releaseRoleMutation = resolve; });
    const memberID = memberIDs.get(memberEmail);
    if (!memberID) throw new Error('missing group member ID for role mutation');
    await owner.route(`**/api/chat/groups/${groupID}/members/${memberID}`, async route => {
      if (route.request().method() === 'PATCH') {
        signalRoleMutation();
        await roleMutationGate;
      }
      await route.continue();
    });
    const roleMutationResponse = owner.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}/members/${memberID}`) && response.request().method() === 'PATCH');
    await ownerMemberRow.getByRole('button', {name: /Make Member an admin/}).click();
    await roleMutationStarted;
    try {
      await expect(ownerMemberRow.locator('.member-action-button')).toHaveCount(3);
      await expect(owner.locator('.group-settings-panel')).toHaveAttribute('aria-busy', 'true');
      expect(await ownerMemberRow.locator('.member-action-button').evaluateAll(buttons => buttons.every(button => (button as HTMLButtonElement).disabled))).toBe(true);
      const loadingStatus = owner.locator('.group-settings-loading');
      await expect(loadingStatus).toHaveText('Saving group settings…');
      const lightLoadingContrast = await measureRenderedTextContrast(loadingStatus);
      expect(lightLoadingContrast.ratio, `light loading status contrast: ${JSON.stringify(lightLoadingContrast)}`).toBeGreaterThanOrEqual(4.5);
      await owner.setViewportSize({width: 1440, height: 900});
      await owner.screenshot({path: testInfo.outputPath('group-member-actions-loading-disabled-light-1440.png'), fullPage: false});
      await setTheme(owner, 'dark');
      const darkLoadingContrast = await measureRenderedTextContrast(loadingStatus);
      expect(darkLoadingContrast.ratio, `dark loading status contrast: ${JSON.stringify(darkLoadingContrast)}`).toBeGreaterThanOrEqual(4.5);
      await owner.screenshot({path: testInfo.outputPath('group-member-actions-loading-disabled-dark-1440.png'), fullPage: false});
      await setTheme(owner, 'light');
      await owner.setViewportSize({width: 2560, height: 1440});
    } finally {
      releaseRoleMutation();
    }
    expect((await roleMutationResponse).status()).toBe(200);
    await owner.unroute(`**/api/chat/groups/${groupID}/members/${memberID}`);
    await expect(member.getByText('Owner made Member an admin.', {exact: true})).toBeVisible({timeout: 10_000});
    await expect(ownerMemberRow.getByRole('button', {name: 'Make Member a member'})).toBeVisible();
    await expect(ownerMemberRow.getByRole('button', {name: 'Transfer ownership to Member'})).toBeVisible();
    await expect(ownerMemberRow.getByRole('button', {name: 'Remove Member'})).toBeVisible();
    await owner.screenshot({path: testInfo.outputPath('group-message-attribution-light-desktop.png'), fullPage: false});
    await member.screenshot({path: testInfo.outputPath('group-system-attribution-dark-desktop.png'), fullPage: false});
    await addMember(removedEmail);
    await expect(owner.locator('.group-members li')).toHaveCount(3);
    await expect(member.getByText('Owner added Removed to the group.', {exact: true})).toBeVisible({timeout: 10_000});
    await expect(member.getByRole('heading', {name: 'Browser acceptance group'})).toBeVisible();
    await expect(member.locator('.chat-presence')).toHaveText('1 members online', {timeout: 10_000});

    await owner.route(`**/api/chat/groups/${groupID}`, async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({status: 500, contentType: 'application/json', body: '{"error":"temporary projection failure"}'});
        return;
      }
      await route.continue();
    });
    const membershipRecovery = await ownerContext.request.patch(`${chatBase}/api/chat/groups/${groupID}/members/${memberIDs.get(memberEmail)}`, {
      headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`},
      data: {role: 'member'},
    });
    expect(membershipRecovery.status()).toBe(200);
    await expect(owner.locator('.group-settings-error[role="alert"]')).toContainText('Could not refresh group membership', {timeout: 10_000});
    await expect(owner.getByRole('heading', {name: 'Browser acceptance group'})).toBeVisible();
    await expect(owner.getByRole('button', {name: 'Start group audio call'})).toBeVisible();
    await owner.screenshot({path: testInfo.outputPath('group-projection-transient-error-dark.png'), fullPage: false, timeout: 15_000});
    await owner.unroute(`**/api/chat/groups/${groupID}`);
    await owner.getByRole('button', {name: 'Refresh chats'}).click();
    await expect(owner.locator('.group-settings-error')).toHaveCount(0, {timeout: 10_000});
    const memberRow = owner.locator('.group-members li').filter({has: owner.locator('.member-identity strong').getByText('Member', {exact: true})});
    await expect(memberRow).toContainText('member', {timeout: 10_000});
    await expect(owner.getByRole('button', {name: 'Start group audio call'})).toBeVisible();
    const restoreAdmin = await ownerContext.request.patch(`${chatBase}/api/chat/groups/${groupID}/members/${memberIDs.get(memberEmail)}`, {
      headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`},
      data: {role: 'admin'},
    });
    expect(restoreAdmin.status()).toBe(200);
    await expect(memberRow).toContainText('admin', {timeout: 10_000});

    await owner.route(`**/api/chat/groups/${groupID}`, route => route.fulfill({status: 500, contentType: 'application/json', body: '{"error":"test failure"}'}));
    await owner.getByLabel('Name', {exact: true}).fill('Rejected rename');
    await owner.locator('.group-manager form').getByRole('button', {name: 'Save name'}).click();
    await expect(owner.getByRole('alert')).toHaveText('Group changes could not be saved.');
    await owner.unroute(`**/api/chat/groups/${groupID}`);
    await owner.getByLabel('Name', {exact: true}).fill('Browser acceptance group renamed');
    await owner.locator('.group-manager form').getByRole('button', {name: 'Save name'}).click();
    await expect(owner.getByRole('heading', {name: 'Browser acceptance group renamed'})).toBeVisible();

    await member.reload();
    await expect(member.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'})).toBeVisible({timeout: 10_000});
    await member.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'}).click();
    await expect(member.getByRole('button', {name: 'Manage group'})).toBeVisible();
    await member.getByRole('button', {name: 'Manage group'}).click();
    const adminManager = member.locator('.group-manager');
    const adminOwnerRow = adminManager.locator('.group-members > li').filter({has: member.locator('strong').filter({hasText: /^Owner$/})});
    const adminSelfRow = adminManager.locator('.group-members > li').filter({has: member.locator('strong').filter({hasText: /^Member$/})});
    const adminTargetRow = adminManager.locator('.group-members > li').filter({has: member.locator('strong').filter({hasText: /^Removed$/})});
    await expect(adminOwnerRow.locator('.member-actions')).toHaveCount(0);
    await expect(adminSelfRow.locator('.member-actions')).toHaveCount(0);
    await expect(adminTargetRow.getByRole('button', {name: 'Make Removed an admin'})).toBeVisible();
    await expect(adminTargetRow.getByRole('button', {name: 'Remove Removed'})).toBeVisible();
    await expect(adminTargetRow.getByRole('button', {name: /Transfer ownership/})).toHaveCount(0);
    await setTheme(member, 'dark');
    await member.screenshot({path: testInfo.outputPath('group-settings-admin-dark-owner-target-hidden.png'), fullPage: false});

    const removedMemberRow = owner.locator('.group-members > li').filter({has: owner.locator('strong').filter({hasText: /^Removed$/})});
    await owner.once('dialog', async dialog => {
      expect(dialog.message()).toBe('Remove this member?');
      await dialog.accept();
    });
    const removeResponse = owner.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}/members/${memberIDs.get(removedEmail)}`) && response.request().method() === 'DELETE');
    await removedMemberRow.getByRole('button', {name: 'Remove Removed'}).click();
    expect((await removeResponse).status()).toBe(200);
    await expect(removedMemberRow).toHaveCount(0);

    await owner.once('dialog', async dialog => {
      expect(dialog.message()).toBe('Transfer ownership?');
      await dialog.accept();
    });
    const transferResponse = owner.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}/ownership`) && response.request().method() === 'POST');
    await ownerMemberRow.getByRole('button', {name: 'Transfer ownership to Member'}).click();
    expect((await transferResponse).status()).toBe(200);
    await expect(ownerMemberRow.locator('.member-identity small')).toHaveText('owner');
    await expect(owner.locator('.group-members > li').filter({has: owner.locator('strong').filter({hasText: /^Owner$/})}).locator('.member-identity small')).toHaveText('admin');

  } finally {
    await Promise.allSettled([ownerContext.close(), memberContext.close()]);
  }
});

test('attributes group messages and system actions to their members', async ({browser}, testInfo) => {
  test.setTimeout(90_000);
  const ownerEmail = uniqueEmail('group-attribution-owner');
  const memberEmail = uniqueEmail('group-attribution-member');
  const ownerContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const memberContext = await browser.newContext({viewport: {width: 390, height: 844}});
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();

  try {
    await register(owner, ownerEmail, 'Owner');
    await register(member, memberEmail, 'Member');
    await waitForLiveConnection(owner);
    const token = await authenticatedToken(ownerContext, ownerEmail, 'group-attribution-owner');
    const created = await ownerContext.request.post(`${chatBase}/api/chat/groups`, {
      headers: {Authorization: `${token.token_type} ${token.access_token}`}, data: {name: 'Attribution group', member_ids: []},
    });
    expect(created.status()).toBe(201);
    await owner.reload();
    await waitForLiveConnection(owner);
    await expect(owner.locator('.person-option').filter({hasText: 'Attribution group'})).toBeVisible({timeout: 10_000});
    await owner.locator('.person-option').filter({hasText: 'Attribution group'}).click();
    await owner.getByRole('button', {name: 'Manage group'}).click();
    await owner.getByLabel('Find a person').fill(memberEmail);
    await owner.getByRole('option', {name: new RegExp(memberEmail)}).click();
    await owner.getByRole('button', {name: 'Add member'}).click();

    await expect(member.locator('.person-option').filter({hasText: 'Attribution group'})).toBeVisible({timeout: 10_000});
    await waitForLiveConnection(member);
    await member.locator('.person-option').filter({hasText: 'Attribution group'}).click();
    await expect(member.locator('.chat-presence')).toHaveText('1 members online', {timeout: 10_000});
    await expect(member.getByText('Owner added Member to the group.', {exact: true})).toBeVisible();
    const groupMessage = `attributed-message-${Date.now()}`;
    await member.getByPlaceholder('Write a message…').fill(groupMessage);
    await member.getByRole('button', {name: 'Send message'}).click();
    const received = owner.locator('.message-bubble').filter({hasText: groupMessage});
    await expect(received).toBeVisible({timeout: 10_000});
    await expect(received.locator('.message-sender')).toHaveText('Member');
    await owner.locator('.group-members li').filter({hasText: 'Member'}).getByRole('button', {name: /Make Member an admin/}).click();
    await expect(member.getByText('Owner made Member an admin.', {exact: true})).toBeVisible({timeout: 10_000});

    await setTheme(owner, 'light');
    await setTheme(member, 'dark');
    await assertChatPresenceContrast(owner, 'light', '1 members online');
    await assertChatPresenceContrast(member, 'dark', '1 members online');
    for (const page of [owner, member]) {
      const viewport = await page.evaluate(() => ({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth}));
      expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
    }
    await owner.screenshot({path: testInfo.outputPath('group-attribution-light-1440.png'), fullPage: false});
    await member.screenshot({path: testInfo.outputPath('group-attribution-dark-390.png'), fullPage: false});

    // Finish all owner-side interactions before disconnecting it; the member view should then
    // converge from the already-verified online projection to the offline count.
    await ownerContext.close();
    await expect(member.locator('.chat-presence')).toHaveText('0 members online', {timeout: 10_000});
    await assertChatPresenceContrast(member, 'dark', '0 members online');
    await member.screenshot({path: testInfo.outputPath('group-attribution-dark-390-owner-offline.png'), fullPage: false});
    await setTheme(member, 'light');
    await assertChatPresenceContrast(member, 'light', '0 members online');
    await member.screenshot({path: testInfo.outputPath('group-attribution-light-390-owner-offline.png'), fullPage: false});
  } finally {
    await Promise.allSettled([ownerContext.close(), memberContext.close()]);
  }
});

test('contains group member, message, and rail lists across the required viewports and themes', async ({browser}, testInfo) => {
  test.setTimeout(180_000);
  const ownerEmail = uniqueEmail('group-visual-owner');
  const memberEmails = Array.from({length: 11}, (_, index) => uniqueEmail(`group-visual-member-${index}`));
  const ownerContext = await browser.newContext({viewport: {width: 2560, height: 1440}});
  const owner = await ownerContext.newPage();

  try {
    await register(owner, ownerEmail, 'Owner');
    for (const [index, email] of memberEmails.entries()) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await register(page, email, `Member ${index + 1}`);
      await context.close();
    }
    await waitForLiveConnection(owner);
    const ownerToken = await authenticatedToken(ownerContext, ownerEmail, 'group-visual-owner');
    const memberIDs = await Promise.all(memberEmails.map(email => userID(ownerContext, ownerToken, email)));
    const created = await ownerContext.request.post(`${chatBase}/api/chat/groups`, {
      headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`}, data: {name: 'Browser acceptance group renamed', member_ids: memberIDs},
    });
    expect(created.status()).toBe(201);
    const groupID = (await created.json() as {id: string}).id;
    const adminResponse = await ownerContext.request.patch(`${chatBase}/api/chat/groups/${groupID}/members/${memberIDs[0]}`, {
      headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`}, data: {role: 'admin'},
    });
    expect(adminResponse.status()).toBe(200);
    const firstGroupMessage = `group-visual-message-${Date.now()}`;
    await owner.reload();
    await expect(owner.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'})).toBeVisible({timeout: 10_000});
    await owner.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'}).click();
    await owner.getByRole('button', {name: 'Manage group'}).click();
    await expect(owner.locator('.group-members li')).toHaveCount(12);
    await owner.getByPlaceholder('Write a message…').fill(firstGroupMessage);
    await owner.getByRole('button', {name: 'Send message'}).click();
    await expect(owner.getByText(firstGroupMessage)).toBeVisible();
    for (let index = 0; index < 12; index += 1) {
      const response = await ownerContext.request.post(`${chatBase}/api/chat/groups`, {
        headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`}, data: {name: `Archive group ${index + 1}`, member_ids: []},
      });
      expect(response.status()).toBe(201);
    }
    await owner.reload();
    await expect(owner.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'})).toBeVisible({timeout: 10_000});
    await owner.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'}).click();
    await owner.getByRole('button', {name: 'Manage group'}).click();
    for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
      await assertGroupLayout(owner, testInfo, 'dark', viewport);
      await assertGroupLayout(owner, testInfo, 'light', viewport);
    }
    await assertMobileGroupRail(owner, testInfo, 'dark');
    await assertMobileGroupRail(owner, testInfo, 'light');
    const touchContext = await browser.newContext({viewport: {width: 390, height: 844}, hasTouch: true});
    try {
      const touchOwner = await touchContext.newPage();
      await touchOwner.goto('/login');
      await login(touchOwner, ownerEmail);
      await waitForLiveConnection(touchOwner);
      await setTheme(touchOwner, 'dark');
      const touchGroup = touchOwner.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'});
      await expect(touchGroup).toBeVisible();
      await touchGroup.click();
      await touchOwner.getByRole('button', {name: 'Manage group'}).click();
      const touchAdminRow = touchOwner.locator('.group-members > li').filter({has: touchOwner.locator('strong').filter({hasText: /^Member 1$/})});
      const touchMakeMember = touchAdminRow.getByRole('button', {name: 'Make Member 1 a member', exact: true});
      await expect(touchMakeMember).toHaveAttribute('aria-label', 'Make Member 1 a member');
      expect(await touchMakeMember.evaluate(button => {
        const rect = button.getBoundingClientRect();
        return {width: rect.width, height: rect.height};
      })).toEqual({width: 44, height: 44});
      const touchRoleResponse = touchOwner.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}/members/${memberIDs[0]}`) && response.request().method() === 'PATCH');
      await touchMakeMember.tap();
      expect((await touchRoleResponse).status()).toBe(200);
      await expect(touchAdminRow.locator('.member-identity small')).toHaveText('member');
      await touchOwner.screenshot({path: testInfo.outputPath('group-settings-touch-dark-390.png'), fullPage: false});
    } finally {
      await touchContext.close();
    }
    await owner.setViewportSize({width: 1440, height: 900});
    await setTheme(owner, 'dark');
    await owner.once('dialog', dialog => dialog.accept());
    const deleteResponse = owner.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}`) && response.request().method() === 'DELETE');
    await owner.getByRole('button', {name: 'Delete group'}).click();
    expect((await deleteResponse).status()).toBe(204);
    await expect(owner.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'})).toHaveCount(0);
    const deletedProjection = await ownerContext.request.get(`${chatBase}/api/chat/groups/${groupID}`, {headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`}});
    expect(deletedProjection.status()).toBe(404);
  } finally {
    await ownerContext.close();
  }
});

test('removing a member from an active group call stops only that member media and sends a minimal terminal projection', async ({browser}, testInfo) => {
  test.setTimeout(120_000);
  const ownerEmail = uniqueEmail('group-call-removal-owner');
  const removedEmail = uniqueEmail('group-call-removal-member');
  const remainingEmail = uniqueEmail('group-call-removal-remaining');
  const ownerContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const removedContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const remainingContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const owner = await ownerContext.newPage();
  const removed = await removedContext.newPage();
  const remaining = await remainingContext.newPage();
  let captureTerminalProjection = false;
  const removedTerminalPayloadKeys: string[][] = [];

  try {
    await Promise.all([
      installDeterministicGroupMedia(owner, '#b84a3a'),
      installDeterministicGroupMedia(removed, '#2563eb'),
      installDeterministicGroupMedia(remaining, '#15803d'),
    ]);
    await removed.routeWebSocket('**/ws/v2*', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => {
        if (typeof message === 'string') {
          try {
            const event = JSON.parse(message) as {type?: string; payload?: unknown};
            if (captureTerminalProjection && event.type === 'group.call.ended' && typeof event.payload === 'object' && event.payload !== null) {
              removedTerminalPayloadKeys.push(Object.keys(event.payload).sort());
            }
          } catch { /* Preserve malformed or non-JSON frames without recording them. */ }
        }
        socket.send(message);
      });
      socket.onMessage(message => server.send(message));
    });
    await Promise.all([register(owner, ownerEmail, 'Owner'), register(removed, removedEmail, 'Removed'), register(remaining, remainingEmail, 'Remaining')]);
    await Promise.all([waitForLiveConnection(owner), waitForLiveConnection(removed), waitForLiveConnection(remaining)]);

    const token = await authenticatedToken(ownerContext, ownerEmail, 'group-call-removal-owner');
    const [removedID, remainingID] = await Promise.all([userID(ownerContext, token, removedEmail), userID(ownerContext, token, remainingEmail)]);
    const created = await ownerContext.request.post(`${chatBase}/api/chat/groups`, {
      headers: {Authorization: `${token.token_type} ${token.access_token}`},
      data: {name: 'Active call membership group', member_ids: [removedID, remainingID]},
    });
    expect(created.status()).toBe(201);
    await Promise.all([owner, removed, remaining].map(async page => {
      await page.reload();
      const conversation = page.locator('.person-option').filter({hasText: 'Active call membership group'});
      await expect(conversation).toBeVisible({timeout: 10_000});
      await conversation.click();
      await expect(page.getByRole('button', {name: 'Start group audio call'})).toBeVisible();
    }));

    await owner.getByRole('button', {name: 'Start group audio call'}).click();
    await removed.getByRole('button', {name: 'Join call'}).click();
    await remaining.getByRole('button', {name: 'Join call'}).click();
    await expect(owner.locator('.group-call-panel')).toContainText('3 participants in the group call.', {timeout: 10_000});
    await expect(removed.locator('.group-call-panel')).toContainText('3 participants in the group call.', {timeout: 10_000});
    await expect.poll(async () => removed.locator('audio[groupRemoteAudio]').evaluateAll(audios => audios.length > 0 && audios.every(audio => !audio.paused)), {timeout: 10_000}).toBeTruthy();

    captureTerminalProjection = true;
    const deletion = await ownerContext.request.delete(`${chatBase}/api/chat/groups/${(await created.json() as {id: string}).id}/members/${removedID}`, {
      headers: {Authorization: `${token.token_type} ${token.access_token}`},
    });
    expect(deletion.status()).toBe(200);
    await expect.poll(() => removedTerminalPayloadKeys.length, {timeout: 10_000}).toBeGreaterThan(0);
    expect(removedTerminalPayloadKeys).toEqual(removedTerminalPayloadKeys.map(() => ['generation', 'room_id', 'state_revision', 'status']));
    await expect(removed.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 10_000});
    await expect(removed.locator('.group-call-devices')).not.toBeVisible();
    await expect(removed.locator('.group-call-actions')).not.toBeVisible();
    await expect(owner.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 10_000});
    await expect(remaining.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 10_000});
    await expect(removed.locator('.person-option').filter({hasText: 'Active call membership group'})).toHaveCount(0);
    await expect(owner.locator('audio[groupRemoteAudio]')).toHaveCount(0);
    await expect(remaining.locator('audio[groupRemoteAudio]')).toHaveCount(0);
    for (const page of [owner, removed, remaining]) {
      await expect.poll(() => page.evaluate(() => {
        const tracks = (window as Window & {__groupLocalTracks?: MediaStreamTrack[]}).__groupLocalTracks ?? [];
        return tracks.length > 0 && tracks.every(track => track.readyState === 'ended');
      }), {timeout: 10_000}).toBeTruthy();
    }

    const message = `remaining-authorized-${Date.now()}`;
    await remaining.getByPlaceholder('Write a message…').fill(message);
    await remaining.getByRole('button', {name: 'Send message'}).click();
    await expect(owner.getByText(message)).toBeVisible({timeout: 10_000});
    await expect(removed.getByText(message)).toHaveCount(0);
    await owner.screenshot({path: testInfo.outputPath('group-call-removal-owner-terminal.png'), fullPage: false});
    await removed.screenshot({path: testInfo.outputPath('group-call-removal-removed-terminal.png'), fullPage: false});
    await remaining.screenshot({path: testInfo.outputPath('group-call-removal-remaining-active.png'), fullPage: false});
  } finally {
    await Promise.allSettled([ownerContext.close(), removedContext.close(), remainingContext.close()]);
  }
});

test('runs a deterministic three-member group media lifecycle', async ({browser}, testInfo) => {
  test.setTimeout(180_000);
  const ownerEmail = uniqueEmail('group-media-owner');
  const memberEmail = uniqueEmail('group-media-member');
  const observerEmail = uniqueEmail('group-media-observer');
  const ownerContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const memberContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const observerContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();
  const observer = await observerContext.newPage();
  let dropObserverTerminal = false;

  try {
    await observer.routeWebSocket('**/ws/v2*', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => {
        if (dropObserverTerminal && typeof message === 'string') {
          try { if ((JSON.parse(message) as {type?: string}).type === 'group.call.ended') return; } catch { /* Forward non-JSON frames unchanged. */ }
        }
        socket.send(message);
      });
      socket.onMessage(message => server.send(message));
    });
    await Promise.all([
      installDeterministicGroupMedia(owner, '#b84a3a'),
      installDeterministicGroupMedia(member, '#2563eb'),
      installDeterministicGroupMedia(observer, '#15803d'),
    ]);
    await register(owner, ownerEmail, 'Group owner');
    await register(member, memberEmail, 'Group member');
    await register(observer, observerEmail, 'Group observer');
    await Promise.all([waitForLiveConnection(owner), waitForLiveConnection(member), waitForLiveConnection(observer)]);

    const ownerToken = await authenticatedToken(ownerContext, ownerEmail, 'group-media-owner');
    const [memberID, observerID] = await Promise.all([
      userID(ownerContext, ownerToken, memberEmail),
      userID(ownerContext, ownerToken, observerEmail),
    ]);
    const created = await ownerContext.request.post(`${chatBase}/api/chat/groups`, {
      headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`},
      data: {name: 'Deterministic media group', member_ids: [memberID, observerID]},
    });
    expect(created.status()).toBe(201);

    for (const page of [owner, member, observer]) {
      await page.reload();
      const group = page.locator('.person-option').filter({hasText: 'Deterministic media group'});
      await expect(group).toBeVisible({timeout: 10_000});
      await group.click();
      const startGroupCall = page.getByRole('button', {name: 'Start group audio call'});
      await expect(startGroupCall).toBeVisible();
      await expect(startGroupCall).toBeEnabled({timeout: 10_000});
    }

    await assertGroupPresenceContrast(owner, testInfo, 'light');
    await assertGroupPresenceContrast(owner, testInfo, 'dark');

    await owner.getByRole('button', {name: 'Start group audio call'}).click();
    await expect(owner.locator('.group-call-panel')).toBeVisible();
    await expect(member.getByRole('button', {name: 'Join call'})).toBeVisible({timeout: 10_000});
    await expect(observer.getByRole('button', {name: 'Join call'})).toBeVisible({timeout: 10_000});
    await member.getByRole('button', {name: 'Join call'}).click();
    await expect(owner.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000});
    await expect(member.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000});
    await expect.poll(() => owner.evaluate(() => (window as Window & {__groupSyncRequests?: string[]}).__groupSyncRequests?.length ?? 0), {timeout: 20_000}).toBeGreaterThan(0);
    await Promise.all([owner, member].map(page => assertGroupCallAudioConnected(page)));

    await expect(owner.locator('.group-call-participants')).toContainText('Group owner');
    await expect(owner.locator('.group-call-participants')).toContainText('Group member');
    await expect(owner.locator('app-call-profile')).toContainText('Deterministic media group');
    await expect(owner.locator('app-call-participants')).toContainText('Group owner');
    await owner.getByRole('button', {name: 'Mute microphone'}).click();
    await expect(owner.getByRole('button', {name: 'Unmute microphone'})).toBeVisible();
    await owner.getByRole('button', {name: 'Unmute microphone'}).click();
    await expect(owner.getByRole('button', {name: 'Mute microphone'})).toBeVisible();
    const deviceControls = owner.locator('.group-call-devices [role="combobox"]');
    await expect(deviceControls).toHaveCount(3);
    await expect(owner.getByLabel('Microphone input')).toBeEnabled();
    await expect(owner.getByLabel('Speaker output')).toBeEnabled();
    await expect(owner.getByLabel('Presentation quality')).toContainText('720p · balanced');

    await member.getByRole('button', {name: 'Present screen'}).click();
    await expect(member.getByRole('button', {name: 'Stop presenting'})).toBeVisible();
    await expect(owner.locator('.group-presentation')).toBeVisible({timeout: 10_000});
    await expect.poll(async () => owner.locator('.group-presentation').evaluate(video => {
      const presentation = video as HTMLVideoElement;
      const track = presentation.srcObject?.getVideoTracks()[0];
      return presentation.srcObject?.active === true && track?.kind === 'video' && track.readyState === 'live';
    }), {timeout: 10_000}).toBeTruthy();
    await owner.screenshot({path: testInfo.outputPath('group-call-remote-presentation-dark.png'), fullPage: false, timeout: 15_000});

    // Acceptance matrix: late join with a live share at 1440x900/dark, plus the
    // existing 2560/1440/1024/390 call-card layout checks in both themes and
    // light/dark presence contrast checks above.
    await observer.getByRole('button', {name: 'Join call'}).click();
    await expect(observer.locator('.group-call-panel')).toContainText('3 participants in the group call.', {timeout: 10_000});
    await expect.poll(async () => observer.locator('.group-presentation').evaluate(video => {
      const presentation = video as HTMLVideoElement;
      const track = presentation.srcObject?.getVideoTracks()[0];
      const rect = presentation.getBoundingClientRect();
      let frameBrightness = 0;
      try {
        const frame = document.createElement('canvas');
        frame.width = 1;
        frame.height = 1;
        const context = frame.getContext('2d');
        if (context && presentation.videoWidth > 0 && presentation.videoHeight > 0) {
          // Sample the center of the source frame: browser letterboxing can make
          // the video's top-left rendered pixel black even while the captured
          // presentation is visibly live in the middle of its stage.
          context.drawImage(presentation, presentation.videoWidth / 2, presentation.videoHeight / 2, 1, 1, 0, 0, 1, 1);
          const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
          frameBrightness = red + green + blue;
        }
      } catch { /* Keep waiting for the browser to render the next received frame. */ }
      return presentation.srcObject?.active === true && track?.kind === 'video' && track.readyState === 'live'
        && rect.width > 0 && rect.height > 0 && getComputedStyle(presentation).visibility === 'visible' && frameBrightness > 80;
    }), {timeout: 20_000}).toBeTruthy();
    await observer.screenshot({path: testInfo.outputPath('group-call-late-join-presentation-dark.png'), fullPage: false, timeout: 15_000});

    await member.getByRole('button', {name: 'Leave call'}).click();
    await expect(owner.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000});
    await expect(observer.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000});
    await expect(member.locator('.group-call-terminal')).toContainText('You left the group call.');
    await expect(owner.locator('.group-presentation')).toBeHidden({timeout: 10_000});
    await expect(observer.locator('.group-presentation')).toBeHidden({timeout: 10_000});
    await expect(owner.locator('audio[groupRemoteAudio]')).toHaveCount(1);
    await owner.getByRole('button', {name: 'Minimize group call'}).click();
    await expect(owner.locator('.group-call-minimized')).toBeVisible();
    await expect(owner.locator('audio[groupRemoteAudio]')).toHaveCount(0);
    await owner.screenshot({path: testInfo.outputPath('group-call-minimized-dark.png'), fullPage: false, timeout: 15_000});
    await owner.getByRole('button', {name: 'Return to group call'}).click();
    await expect(owner.locator('.group-call-panel')).toBeVisible();
    await expect(owner.locator('audio[groupRemoteAudio]')).toHaveCount(1);
    await expect.poll(async () => owner.locator('audio[groupRemoteAudio]').evaluateAll(audios => audios.length === 1 && audios.every(audio => !audio.paused)), {timeout: 10_000}).toBeTruthy();
    await owner.screenshot({path: testInfo.outputPath('group-call-restored-dark.png'), fullPage: false, timeout: 15_000});

    const dark = await assertGroupCallLayout(owner, testInfo, 'dark', {width: 1440, height: 900});
    const light = await assertGroupCallLayout(owner, testInfo, 'light', {width: 1440, height: 900});
    await assertGroupCallLayout(owner, testInfo, 'dark', {width: 2560, height: 1440});
    await assertGroupCallLayout(owner, testInfo, 'light', {width: 2560, height: 1440});
    expect(light.surface).not.toBe(dark.surface);
    await assertGroupCallLayout(owner, testInfo, 'dark', {width: 1024, height: 900});
    await assertGroupCallLayout(owner, testInfo, 'light', {width: 1024, height: 900});
    await assertGroupCallLayout(owner, testInfo, 'dark', {width: 390, height: 844});
    await assertGroupCallLayout(owner, testInfo, 'light', {width: 390, height: 844});

    const observerSyncsBeforeTerminal = await observer.evaluate(() => (window as Window & {__groupSyncRequests?: string[]}).__groupSyncRequests?.length ?? 0);
    dropObserverTerminal = true;
    await owner.getByRole('button', {name: 'End call'}).click();
    await expect.poll(() => observer.evaluate(() => (window as Window & {__groupSyncRequests?: string[]}).__groupSyncRequests?.length ?? 0), {timeout: 20_000}).toBeGreaterThan(observerSyncsBeforeTerminal);
    await expect(observer.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 30_000});
    await expect(observer.locator('.group-call-devices')).not.toBeVisible();
    await expect(observer.locator('.group-call-actions')).not.toBeVisible();
    await expect(observer.locator('.group-call-terminal')).toBeVisible();
    await expect(observer.locator('app-call-terminal-notice')).toContainText('Group call ended.');
    await owner.evaluate(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {configurable: true, value: async () => Promise.reject(new DOMException('denied', 'NotAllowedError'))}));
    await owner.getByRole('button', {name: 'Start group audio call'}).click();
    await expect(owner.locator('.group-call-terminal')).toContainText('Microphone permission was denied.', {timeout: 5_000});
    await owner.screenshot({path: testInfo.outputPath('group-call-error-light-390.png'), fullPage: false, timeout: 15_000});
  } finally {
    await Promise.allSettled([ownerContext.close(), memberContext.close(), observerContext.close()]);
  }
});
