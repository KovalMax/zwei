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

async function waitForReadableTooltip(tooltip: Locator): Promise<RenderedTextContrast> {
  const deadline = Date.now() + 5_000;
  let contrast: RenderedTextContrast | undefined;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    contrast = await measureRenderedTextContrastAtSurface(tooltip, undefined, remaining);
    if (contrast.ratio >= 4.5) return contrast;
    await tooltip.evaluate(element => new Promise<void>(resolve => requestAnimationFrame(() => resolve())), undefined, {timeout: Math.max(1, deadline - Date.now())});
  }
  throw new Error(`Tooltip did not reach 4.5:1 rendered contrast: ${JSON.stringify(contrast)}`);
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

async function measureRenderedTextContrastAtSurface(element: Locator, pseudoElement?: '::placeholder', timeout = 0): Promise<RenderedTextContrast> {
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
    const effectiveOpacity = foregroundOpacity;
    const renderedForeground = composite([foreground[0], foreground[1], foreground[2], foregroundOpacity], background);
    const foregroundLuminance = luminance(renderedForeground);
    const backgroundLuminance = luminance(background);
    return {
      foreground: foregroundColor,
      background: `rgba(${background[0]}, ${background[1]}, ${background[2]}, ${background[3]})`,
      ratio: (Math.max(foregroundLuminance, backgroundLuminance) + .05) / (Math.min(foregroundLuminance, backgroundLuminance) + .05),
      opacity: effectiveOpacity,
      disabled: 'disabled' in node && Boolean((node as HTMLInputElement).disabled),
    };
  }, pseudoElement, {timeout});
}

async function measureCallNotificationSurface(page: Page, cardSelector: string) {
  return page.evaluate(selector => {
    const panel = document.querySelector<HTMLElement>('.call-panel:not(.call-panel-full)');
    const card = panel?.querySelector<HTMLElement>(selector);
    const actions = card?.querySelector<HTMLElement>('.call-actions');
    const profile = card?.querySelector<HTMLElement>('app-call-profile');
    const panelStyle = panel ? getComputedStyle(panel) : undefined;
    const panelBounds = panel?.getBoundingClientRect();
    const header = panel?.parentElement?.querySelector<HTMLElement>('.chat-header');
    const headerStyle = header ? getComputedStyle(header) : undefined;
    const cardStyle = card ? getComputedStyle(card) : undefined;
    const actionsStyle = actions ? getComputedStyle(actions) : undefined;
    const rect = (element?: HTMLElement) => {
      const bounds = element?.getBoundingClientRect();
      return bounds ? {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height} : undefined;
    };
    return {
      panel: rect(panel), header: rect(header), card: rect(card), actions: rect(actions), profile: rect(profile),
      panelPadding: panelStyle ? {top: panelStyle.paddingTop, right: panelStyle.paddingRight, bottom: panelStyle.paddingBottom, left: panelStyle.paddingLeft} : undefined,
      headerPadding: headerStyle ? {top: headerStyle.paddingTop, right: headerStyle.paddingRight, bottom: headerStyle.paddingBottom, left: headerStyle.paddingLeft} : undefined,
      contentLeft: panelBounds && panelStyle ? panelBounds.left + Number.parseFloat(panelStyle.paddingLeft) : undefined,
      contentRight: panelBounds && panelStyle ? panelBounds.right - Number.parseFloat(panelStyle.paddingRight) : undefined,
      buttons: Array.from(actions?.querySelectorAll<HTMLElement>('button') ?? []).flatMap(button => {
        const bounds = rect(button);
        return bounds ? [bounds] : [];
      }),
      profileCopy: Array.from(profile?.querySelectorAll<HTMLElement>('.call-presentation-copy strong, .call-presentation-copy span') ?? []).map(element => {
        const style = getComputedStyle(element);
        return {scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, overflow: style.overflow, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace};
      }),
      profileActionsOverlap: Boolean(profile && actions && profile.getBoundingClientRect().left < actions.getBoundingClientRect().right && profile.getBoundingClientRect().right > actions.getBoundingClientRect().left && profile.getBoundingClientRect().top < actions.getBoundingClientRect().bottom && profile.getBoundingClientRect().bottom > actions.getBoundingClientRect().top),
      panelSurface: panel ? getComputedStyle(panel).backgroundColor : '',
      cardSurface: card ? getComputedStyle(card).backgroundColor : '',
      actionSurface: actions ? getComputedStyle(actions).backgroundColor : '',
      panelBottomBorderColor: panelStyle?.borderBottomColor ?? '',
      panelBottomBorderStyle: panelStyle?.borderBottomStyle ?? '',
      headerBottomBorderColor: headerStyle?.borderBottomColor ?? '',
      headerBottomBorderStyle: headerStyle?.borderBottomStyle ?? '',
      cardBorderWidth: cardStyle?.borderWidth ?? '',
      cardBorderRadius: cardStyle?.borderRadius ?? '',
      cardBoxShadow: cardStyle?.boxShadow ?? '',
      cardMargin: cardStyle?.margin ?? '',
      actionBorderWidth: actionsStyle?.borderWidth ?? '',
      actionBoxShadow: actionsStyle?.boxShadow ?? '',
      panelText: panel ? getComputedStyle(panel).color : '',
      actionText: actions ? getComputedStyle(actions).color : '',
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      panelScrollWidth: panel?.scrollWidth,
      panelClientWidth: panel?.clientWidth,
      cardScrollWidth: card?.scrollWidth,
      cardClientWidth: card?.clientWidth,
    };
  }, cardSelector);
}

type CallNotificationSurface = Awaited<ReturnType<typeof measureCallNotificationSurface>>;

function expectCallNotificationLayout(surface: CallNotificationSurface, context: string, viewport: {width: number; height: number}): void {
  if (viewport.width === 390 || viewport.width === 1440) {
    console.info(`DIRECT_CALL_HEADER_PARITY ${JSON.stringify({context, header: surface.header, panel: surface.panel, card: surface.card, panelPadding: surface.panelPadding, headerPadding: surface.headerPadding})}`);
  }
  expect(surface.panel?.height, context).toBe(surface.header?.height);
  expect(surface.panelPadding?.top, context).toBe('0px');
  expect(surface.panelPadding?.bottom, context).toBe('0px');
  expect(surface.panelPadding?.left, context).toBe(surface.headerPadding?.left);
  expect(surface.panelPadding?.right, context).toBe(surface.headerPadding?.right);
  expect(surface.panelSurface, context).toBe(surface.cardSurface);
  expect(surface.actionSurface, context).toBe(surface.cardSurface);
  expect(surface.panelBottomBorderColor, context).toBe(surface.headerBottomBorderColor);
  expect(surface.panelBottomBorderStyle, context).toBe(surface.headerBottomBorderStyle);
  expect(surface.cardBorderWidth, context).toBe('0px');
  expect(surface.cardBorderRadius, context).toBe('0px');
  expect(surface.cardBoxShadow, context).toBe('none');
  expect(surface.cardMargin, context).toBe('0px');
  expect(surface.actionBorderWidth, context).toBe('0px');
  expect(surface.actionBoxShadow, context).toBe('none');
  expect(surface.card?.left, context).toBeCloseTo(surface.contentLeft ?? 0, 0);
  expect(surface.card?.right, context).toBeCloseTo(surface.contentRight ?? viewport.width, 0);
  expect(Math.abs((surface.card?.height ?? 0) - (surface.header?.height ?? 0)), context).toBeLessThanOrEqual(1);
  expect(surface.profile?.left, context).toBeCloseTo(surface.card?.left ?? 0, 0);
  expect(surface.actions?.left, context).toBeGreaterThanOrEqual((surface.card?.left ?? 0) - 1);
  expect(surface.actions?.right, context).toBeCloseTo(surface.card?.right ?? viewport.width, 0);
  expect(surface.profileActionsOverlap, context).toBe(false);
  expect(surface.profile?.right, context).toBeLessThanOrEqual((surface.buttons[0]?.left ?? viewport.width) + 1);
  expect(surface.documentWidth, context).toBeLessThanOrEqual(surface.viewportWidth + 1);
  expect(surface.panelScrollWidth, context).toBeLessThanOrEqual((surface.panelClientWidth ?? 0) + 1);
  expect(surface.cardScrollWidth, context).toBeLessThanOrEqual((surface.cardClientWidth ?? 0) + 1);
  expect(surface.panel?.left, context).toBeGreaterThanOrEqual(0);
  expect(surface.panel?.right, context).toBeLessThanOrEqual(viewport.width + 1);
  expect(surface.actions?.top, context).toBeGreaterThanOrEqual((surface.panel?.top ?? 0) - 1);
  expect(surface.actions?.bottom, context).toBeLessThanOrEqual((surface.panel?.bottom ?? viewport.height) + 1);
  for (const [index, button] of surface.buttons.entries()) {
    expect(button.left, context).toBeGreaterThanOrEqual((surface.actions?.left ?? 0) - 1);
    expect(button.right, context).toBeLessThanOrEqual((surface.actions?.right ?? viewport.width) + 1);
    expect(button.left, context).toBeGreaterThanOrEqual(0);
    expect(button.right, context).toBeLessThanOrEqual(viewport.width + 1);
    expect(button.top, context).toBeGreaterThanOrEqual(0);
    expect(button.bottom, context).toBeLessThanOrEqual(viewport.height + 1);
    expect(button.top, context).toBeGreaterThanOrEqual((surface.profile?.top ?? 0) - 1);
    expect(button.bottom, context).toBeLessThanOrEqual((surface.profile?.bottom ?? viewport.height) + 1);
    if (index === surface.buttons.length - 1) expect(button.right, context).toBeCloseTo(surface.actions?.right ?? viewport.width, 0);
  }
}

function expectLongCallProfileNameTruncated(surface: CallNotificationSurface, context: string): void {
  expect(surface.profileCopy, context).toHaveLength(2);
  for (const copy of surface.profileCopy) {
    expect(copy.overflow, context).toBe('hidden');
    expect(copy.textOverflow, context).toBe('ellipsis');
    expect(copy.whiteSpace, context).toBe('nowrap');
  }
  expect(surface.profileCopy[0].scrollWidth, context).toBeGreaterThan(surface.profileCopy[0].clientWidth);
}

async function measureCallDeviceRowAlignment(controls: Locator) {
  return controls.evaluate(element => {
    const bounds = (target: Element | null | undefined) => {
      if (!(target instanceof HTMLElement)) return undefined;
      const rect = target.getBoundingClientRect();
      return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height};
    };
    const controlFor = (label: string) => Array.from(element.querySelectorAll<HTMLElement>(':scope > .call-control'))
      .find(control => control.querySelector(':scope > span')?.textContent?.trim() === label);
    const microphone = controlFor('Microphone input');
    const speaker = controlFor('Speaker output');
    const quality = Array.from(element.querySelectorAll<HTMLElement>(':scope > .call-control'))
      .find(control => control.classList.contains('call-quality-control'));
    const qualityTrigger = quality?.querySelector<HTMLElement>('.call-quality-trigger');
    const shareAudio = quality?.querySelector<HTMLElement>('.share-audio-toggle');
    const qualityAudioRow = quality?.querySelector<HTMLElement>('.call-quality-audio-row-feature');
    const microphoneSelect = microphone?.querySelector<HTMLElement>('.call-select');
    const speakerSelect = speaker?.querySelector<HTMLElement>('.call-select');
    const host = element.getBoundingClientRect();
    const qualityBounds = qualityTrigger?.getBoundingClientRect();
    const audioBounds = shareAudio?.getBoundingClientRect();
    return {
      host: {left: host.left, right: host.right, width: host.width},
      microphone: {row: bounds(microphone), control: bounds(microphoneSelect)},
      speaker: {row: bounds(speaker), control: bounds(speakerSelect)},
      deviceRowSpan: microphoneSelect && speakerSelect
        ? {left: Math.min(microphoneSelect.getBoundingClientRect().left, speakerSelect.getBoundingClientRect().left), right: Math.max(microphoneSelect.getBoundingClientRect().right, speakerSelect.getBoundingClientRect().right), width: Math.max(microphoneSelect.getBoundingClientRect().right, speakerSelect.getBoundingClientRect().right) - Math.min(microphoneSelect.getBoundingClientRect().left, speakerSelect.getBoundingClientRect().left)}
        : undefined,
      qualityAudioRow: bounds(qualityAudioRow),
      qualityAudioControls: qualityBounds && audioBounds
        ? {left: Math.min(qualityBounds.left, audioBounds.left), right: Math.max(qualityBounds.right, audioBounds.right), width: Math.max(qualityBounds.right, audioBounds.right) - Math.min(qualityBounds.left, audioBounds.left)}
        : undefined,
    };
  });
}

async function measureShareAudioFocusClip(toggle: Locator) {
  return toggle.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const inset = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
    let clip = {left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight};
    const clippingAncestors: Array<{className: string; overflowX: string; overflowY: string; left: number; right: number; top: number; bottom: number}> = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const ancestorRect = ancestor.getBoundingClientRect();
      const overflowX = ancestorStyle.overflowX;
      const overflowY = ancestorStyle.overflowY;
      if (overflowX !== 'visible' || overflowY !== 'visible') {
        clippingAncestors.push({className: ancestor.className.toString(), overflowX, overflowY, left: ancestorRect.left, right: ancestorRect.right, top: ancestorRect.top, bottom: ancestorRect.bottom});
        if (overflowX !== 'visible') {
          clip.left = Math.max(clip.left, ancestorRect.left);
          clip.right = Math.min(clip.right, ancestorRect.right);
        }
        if (overflowY !== 'visible') {
          clip.top = Math.max(clip.top, ancestorRect.top);
          clip.bottom = Math.min(clip.bottom, ancestorRect.bottom);
        }
      }
    }
    return {
      outline: {style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset},
      toggle: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom},
      ring: {left: rect.left - inset, right: rect.right + inset, top: rect.top - inset, bottom: rect.bottom + inset},
      clip,
      clippingAncestors,
    };
  });
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
      memberRowGaps: listItems.slice(0, -1).map((row, index) => listItems[index + 1].getBoundingClientRect().top - row.getBoundingClientRect().bottom),
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
  expect(top.memberRowGaps.length).toBeGreaterThan(0);
  expect(Math.max(...top.memberRowGaps) - Math.min(...top.memberRowGaps), `${theme}/${viewport.width}px member-card gaps must be uniform: ${JSON.stringify(top.memberRowGaps)}`).toBeLessThanOrEqual(1);
  const expectedMemberGap = viewport.width <= 760 ? 18 : 14.5;
  for (const gap of top.memberRowGaps) expect(Math.abs(gap - expectedMemberGap), `${theme}/${viewport.width}px rendered member-card gap: ${JSON.stringify(top.memberRowGaps)}`).toBeLessThanOrEqual(1);
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
    expect(top.member.background).toBe('rgb(246, 248, 252)');
    expect(top.member.color).toBe('rgb(23, 32, 51)');
    expect(top.trigger.background).toBe('rgb(250, 249, 253)');
    expect(top.trigger.color).toBe('rgb(47, 111, 174)');
  } else {
    expect(top.manager.background).toBe('rgb(32, 44, 59)');
    expect(top.heading).toBe('rgb(241, 245, 249)');
    expect(top.label).toBe('rgb(237, 242, 250)');
    expect(top.member.background).toBe('rgb(38, 53, 70)');
  }
  await assertSettingsBodyClearOfHeading('top');
  await page.mouse.move(0, 0);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await expect(page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface:visible'), `${theme} ${viewport.width}px settings top has no detached action tooltip`).toHaveCount(0);
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
      const style = getComputedStyle(row);
      return {name: row.querySelector('.member-identity')?.textContent?.trim(), top: rect.top, bottom: rect.bottom, fullyVisible: fullyInsideList(rect) && rect.top >= 0 && rect.bottom <= window.innerHeight, surface: style.backgroundColor, color: style.color, border: style.borderColor, borderTopColor: style.borderTopColor, borderStyle: style.borderStyle, radius: style.borderRadius, text, actions: rowActions};
    });
    return {
      edge: requestedEdge,
      memberScroller: {scrollTop: members.scrollTop, scrollHeight: members.scrollHeight, clientHeight: members.clientHeight, scrollWidth: members.scrollWidth, clientWidth: members.clientWidth, paddingBottom: Number.parseFloat(getComputedStyle(members).paddingBottom), overflowY: getComputedStyle(members).overflowY},
       panel: {scrollTop: settings.scrollTop, scrollHeight: settings.scrollHeight, clientHeight: settings.clientHeight, surface: getComputedStyle(settings).backgroundColor},
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
    const tooltip = page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface:visible').filter({hasText: action.label}).last();
    await expect(tooltip, `${theme} ${viewport.width}px tooltip: ${action.label}`).toBeVisible();
    await expect(page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface:visible'), `${theme} ${viewport.width}px must render only the active action tooltip`).toHaveCount(1);
    const contrast = await waitForReadableTooltip(tooltip);
    expect(contrast.ratio, `${theme} ${viewport.width}px ${action.label} rendered contrast: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
    const {tooltipRect, managerRect, tooltipClasses, panelClasses, tooltipStyle} = await page.evaluate(label => {
      const toRect = (element: Element | null) => {
        const rect = element?.getBoundingClientRect();
        return rect ? {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height} : undefined;
      };
      const tooltipElements = Array.from(document.querySelectorAll<HTMLElement>('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface'))
        .filter(element => element.textContent?.trim() === label);
      const surface = tooltipElements[tooltipElements.length - 1];
      const panel = surface?.closest<HTMLElement>('.mat-mdc-tooltip-panel');
      const tooltip = surface?.closest<HTMLElement>('.mat-mdc-tooltip');
      return {
        tooltipRect: toRect(surface ?? null),
        tooltipClasses: tooltip?.className,
        panelClasses: panel?.className,
        tooltipStyle: surface ? {minHeight: getComputedStyle(surface).minHeight, padding: getComputedStyle(surface).padding, fontSize: getComputedStyle(surface).fontSize, lineHeight: getComputedStyle(surface).lineHeight} : undefined,
        managerRect: toRect(document.querySelector('.chat-panel > .group-manager')),
      };
    }, action.label);
    if (!tooltipRect || !managerRect) throw new Error(`Tooltip or group settings geometry was unavailable for ${action.label}: ${JSON.stringify({tooltipRect, managerRect})}`);
    expect(tooltipRect.width, JSON.stringify({theme, viewport, action: action.id, tooltipRect})).toBeGreaterThan(0);
    expect(tooltipRect.height, JSON.stringify({theme, viewport, action: action.id, tooltipRect})).toBeGreaterThan(0);
    expect(`${tooltipClasses} ${panelClasses}`).toContain('group-member-action-tooltip');
    expect(tooltipStyle?.fontSize, `${theme} ${viewport.width}px member action tooltip font`).toBe('10px');
    expect(tooltipRect.height, `${theme} ${viewport.width}px compact member action tooltip height: ${JSON.stringify({tooltipClasses, panelClasses, tooltipStyle})}`).toBeLessThanOrEqual(18);
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
          const visibleText = Array.from(row.querySelectorAll<HTMLElement>('.member-identity strong, .member-identity small'))
            .map(text => {
              const textRect = text.getBoundingClientRect();
              return {text: text.textContent?.trim(), rect: {left: textRect.left, right: textRect.right, top: textRect.top, bottom: textRect.bottom}};
            }).filter(text => intersects(new DOMRect(text.rect.left, text.rect.top, text.rect.right - text.rect.left, text.rect.bottom - text.rect.top)));
          return {label: row.querySelector('.member-identity')?.textContent?.trim(), surfaceRect: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}, visibleText};
        });
      return {controls, rows, textCollisions: rows.flatMap(row => row.visibleText.map(text => ({row: row.label, text: text.text, rect: text.rect})))};
    }, tip);
    expect(collisions.controls, `${theme} ${viewport.width}px ${action.label} overlaps a group control: ${JSON.stringify({tooltip: tip, collisions})}`).toEqual([]);
    expect(collisions.textCollisions, `${theme} ${viewport.width}px ${action.label} obscures member text: ${JSON.stringify({tooltip: tip, collisions})}`).toEqual([]);
  };
  const focusUsingKeyboard = async (button: typeof actionButtons[number]['button']): Promise<void> => {
    await button.scrollIntoViewIfNeeded();
    // Focus can scroll the nested list and settings panel. Finish that movement
    // before testing tooltip recovery so the scroll-dismiss event cannot race it.
    await memberScroller.evaluate(element => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
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
    await page.screenshot({path: testInfo.outputPath(`group-member-action-tooltip-hover-${action.id}-${theme}-${viewport.width}.png`), fullPage: false});
    await focusUsingKeyboard(action.button);
    await assertTooltipGeometry(action);
    await page.screenshot({path: testInfo.outputPath(`group-member-action-${action.id}-keyboard-focus-${theme}-${viewport.width}.png`), fullPage: false});
    if (action.id === 'transfer-owner' && viewport.width === 1440) {
      const focusStyle = await action.button.evaluate(button => ({outlineStyle: getComputedStyle(button).outlineStyle, outlineWidth: getComputedStyle(button).outlineWidth}));
      expect(focusStyle.outlineStyle).not.toBe('none');
      expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(3);
    }
  }
  if (viewport.width === 1440 && theme === 'dark') {
    const resizeTooltip = page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface:visible').filter({hasText: 'Remove'}).last();
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
  const removeTooltip = page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface:visible').filter({hasText: 'Remove'}).last();
  await focusUsingKeyboard(actionButtons[2].button);
  await assertTooltipGeometry(actionButtons[2]);
  await page.mouse.move(0, 0);
  await actionButtons[2].button.hover();
  await assertTooltipGeometry(actionButtons[2]);
  for (let recoveryAttempt = 0; recoveryAttempt < 10; recoveryAttempt++) {
    const listScroll = await scrollMemberListAwayFromCurrentEdge();
    const context = `${theme} ${viewport.width}px recovery ${recoveryAttempt + 1}/10`;
    expect(listScroll.targetScrollTop, JSON.stringify({context, listScroll})).not.toBe(listScroll.before);
    expect(listScroll.scrollEvents, JSON.stringify({context, listScroll})).toBeGreaterThan(0);
    if (listScroll.targetScrollTop === 0) expect(listScroll.scrollTop, context).toBe(0);
    else expect(listScroll.scrollTop + listScroll.clientHeight, context).toBeGreaterThanOrEqual(listScroll.scrollHeight - 1);
    await expect(removeTooltip, `${context} tooltip must clear when the member list scrolls`).not.toBeVisible();
    await expect(visibleTooltips, context).toHaveCount(0);
    await page.mouse.move(1, viewport.height / 2);
    await actionButtons[2].button.scrollIntoViewIfNeeded();
    // Let programmatic repositioning finish before keyboard focus. Its captured
    // scroll event must dismiss tooltips, not race the subsequent focus event.
    await memberScroller.evaluate(element => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(removeTooltip, `${context} repositioning alone must not resurrect the tooltip`).not.toBeVisible();
    await expect(actionButtons[2].button, `${context} list scroll should retain keyboard focus`).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(actionButtons[2].button, `${context} keyboard focus should recover without pointer movement`).toBeFocused();
    await assertTooltipGeometry(actionButtons[2]);
    await expect(removeTooltip, `${context} keyboard focus should reopen after list scrolling`).toBeVisible();
    if (recoveryAttempt === 0) {
      await page.screenshot({path: testInfo.outputPath(`group-member-action-remove-keyboard-recovered-after-list-scroll-${theme}-${viewport.width}.png`), fullPage: false});
    }
  }
  const dismissalScroll = await scrollMemberListAwayFromCurrentEdge();
  expect(dismissalScroll.targetScrollTop, JSON.stringify({theme, viewport, dismissalScroll})).not.toBe(dismissalScroll.before);
  expect(dismissalScroll.scrollEvents, JSON.stringify({theme, viewport, dismissalScroll})).toBeGreaterThan(0);
  await expect(removeTooltip, `${theme} ${viewport.width}px a following scroll must dismiss the recovered tooltip`).not.toBeVisible();
  await page.screenshot({path: testInfo.outputPath(`group-settings-${theme}-${viewport.width}-list-end-scrolled-away-no-tooltip.png`), fullPage: false});
  await page.mouse.move(1, viewport.height / 2);
  await expect(removeTooltip, `${theme} ${viewport.width}px pointer movement must not resurrect a dismissed tooltip`).not.toBeVisible();
  await actionButtons[2].button.scrollIntoViewIfNeeded();
  await memberScroller.evaluate(element => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(removeTooltip, `${theme} ${viewport.width}px repositioning alone must not resurrect the tooltip`).not.toBeVisible();
  await page.mouse.move(1, viewport.height / 2);
  await actionButtons[2].button.hover();
  await assertTooltipGeometry(actionButtons[2]);
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
  for (const row of memberEnd.visibleRows) {
    expect(row.borderStyle, `${theme} ${viewport.width}px member row must have a complete visible border: ${JSON.stringify(row)}`).toBe('solid');
    expect(row.border).not.toBe(row.surface);
    expect(row.surface).not.toBe(memberEnd.panel.surface);
  }
  const memberBorderContrast = await manager.locator('.group-members li').evaluateAll(rows => rows.map(row => {
    const parse = (value: string): number[] => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    const luminance = (value: string): number => parse(value).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const style = getComputedStyle(row);
    const border = style.borderTopColor;
    const surface = style.backgroundColor;
    const borderLuminance = luminance(border);
    const surfaceLuminance = luminance(surface);
    return {row: row.querySelector('.member-identity')?.textContent?.trim(), border, surface, ratio: (Math.max(borderLuminance, surfaceLuminance) + .05) / (Math.min(borderLuminance, surfaceLuminance) + .05)};
  }));
  expect(memberBorderContrast.every(row => row.ratio >= 3), `${theme} ${viewport.width}px group member row border contrast: ${JSON.stringify(memberBorderContrast)}`).toBeTruthy();
  const settingsSurface = await manager.locator('.group-settings-panel').evaluate(element => getComputedStyle(element).backgroundColor);
  for (const row of memberEnd.visibleRows) {
    expect(row.borderStyle, `${theme} ${viewport.width}px member row border: ${JSON.stringify(row)}`).toBe('solid');
    expect(row.border, `${theme} ${viewport.width}px member row border must contrast with its row surface`).not.toBe(row.surface);
    expect(row.surface, `${theme} ${viewport.width}px member row surface must differ from settings surface`).not.toBe(settingsSurface);
  }
   const fullyVisibleEndRows = memberEnd.visibleRows.filter(row => row.fullyVisible);
   expect(fullyVisibleEndRows.length).toBeGreaterThan(0);
   expect(memberEnd.visibleRows.every(row => row.fullyVisible), `${theme} ${viewport.width}px member list should rest on complete rows at its end: ${JSON.stringify(memberEnd.visibleRows)}`).toBeTruthy();
   expect(fullyVisibleEndRows.every(row => row.actions.every(action => action.fullyVisible)), JSON.stringify({theme, viewport, visibleRows: memberEnd.visibleRows})).toBeTruthy();
   // At the end edge, a preceding row may be partially visible at the top of
   // the scrollport. Assert the actual last data row and all of its actions
   // above; do not require the previous row to be moved fully into view too.
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
  const headerControlGeometry = await page.evaluate(() => {
    const describe = (selector: string) => {
      const button = document.querySelector<HTMLElement>(selector);
      if (!button) return undefined;
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      const icon = button.querySelector<HTMLElement>('zwei-icon');
      return {rect: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height}, background: style.backgroundColor, color: style.color, borderColor: style.borderTopColor, borderStyle: style.borderTopStyle, radius: style.borderRadius, iconColor: icon ? getComputedStyle(icon).color : undefined};
    };
    return {groupCall: describe('.chat-header > .call-button'), manage: describe('.group-manage-trigger'), back: describe('.back-button')};
  });
  console.log(`GROUP_HEADER_CONTROLS ${JSON.stringify({theme, viewport, headerControlGeometry})}`);
  const groupCallButton = page.getByRole('button', {name: 'Join or start group audio call'});
  await expect(groupCallButton).toBeVisible();
  const groupCallContrast = await measureRenderedTextContrast(groupCallButton);
  expect(groupCallContrast.ratio, `${theme}/${viewport.width}px group call icon contrast: ${JSON.stringify(groupCallContrast)}`).toBeGreaterThanOrEqual(3);
  expect(headerControlGeometry.groupCall?.rect.width).toBe(48);
  expect(headerControlGeometry.groupCall?.rect.height).toBe(48);
  expect(headerControlGeometry.groupCall?.borderStyle).toBe('solid');
  expect(headerControlGeometry.groupCall?.background).not.toBe('rgba(0, 0, 0, 0)');
  const manageButton = page.getByRole('button', {name: 'Manage group'});
  if (await manageButton.isVisible()) {
    const manageContrast = await measureRenderedTextContrast(manageButton);
    expect(manageContrast.ratio, `${theme}/${viewport.width}px group-manage icon contrast: ${JSON.stringify(manageContrast)}`).toBeGreaterThanOrEqual(3);
    expect(headerControlGeometry.manage?.borderStyle).toBe('solid');
  }
  if (viewport.width === 390) {
    const backButton = page.getByRole('button', {name: 'Back to chats'});
    await expect(backButton).toBeVisible();
    const backContrast = await measureRenderedTextContrast(backButton);
    expect(backContrast.ratio, `${theme} mobile back icon contrast: ${JSON.stringify(backContrast)}`).toBeGreaterThanOrEqual(3);
    expect(headerControlGeometry.back?.borderStyle).toBe('solid');
    expect(headerControlGeometry.back?.background).not.toBe('rgba(0, 0, 0, 0)');
    await backButton.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(backButton).toBeFocused();
    expect(await backButton.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
    await page.screenshot({path: testInfo.outputPath(`group-header-back-focus-${theme}-390.png`), fullPage: false});
    await backButton.blur();
  } else {
    await expect(page.getByRole('button', {name: 'Back to chats'})).toBeHidden();
  }
  if (viewport.width === 390 || viewport.width === 1440) {
    await groupCallButton.hover();
    const hoverBackground = await groupCallButton.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(hoverBackground, `${theme}/${viewport.width}px group-call hover must visibly change its surface`).not.toBe(headerControlGeometry.groupCall?.background);
    await page.screenshot({path: testInfo.outputPath(`group-header-call-action-hover-${theme}-${viewport.width}.png`), fullPage: false});
    await groupCallButton.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(groupCallButton).toBeFocused();
    const focusGeometry = await groupCallButton.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {rect: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}, outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth), outlineOffset: Number.parseFloat(style.outlineOffset), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight};
    });
    expect(focusGeometry.outlineStyle).not.toBe('none');
    const focusInset = focusGeometry.outlineWidth + focusGeometry.outlineOffset;
    expect(focusGeometry.rect.left - focusInset, JSON.stringify(focusGeometry)).toBeGreaterThanOrEqual(0);
    expect(focusGeometry.rect.top - focusInset, JSON.stringify(focusGeometry)).toBeGreaterThanOrEqual(0);
    expect(focusGeometry.rect.right + focusInset, JSON.stringify(focusGeometry)).toBeLessThanOrEqual(focusGeometry.viewportWidth);
    expect(focusGeometry.rect.bottom + focusInset, JSON.stringify(focusGeometry)).toBeLessThanOrEqual(focusGeometry.viewportHeight);
    await page.screenshot({path: testInfo.outputPath(`group-header-call-action-focus-${theme}-${viewport.width}.png`), fullPage: false});
    await groupCallButton.blur();
  }
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
  const searchSpacing = await page.locator('.search-field').evaluate(field => {
    const icon = field.querySelector('zwei-icon')?.getBoundingClientRect();
    const labelElement = field.querySelector('.mdc-floating-label');
    const label = labelElement?.getBoundingClientRect();
    return {iconRight: icon?.right, labelLeft: label?.left, transition: labelElement ? getComputedStyle(labelElement).transitionDuration : undefined};
  });
  expect(searchSpacing.labelLeft, `${theme} mobile search label/icon overlap: ${JSON.stringify(searchSpacing)}`).toBeGreaterThanOrEqual((searchSpacing.iconRight ?? Number.POSITIVE_INFINITY) - 1);
  expect(searchSpacing.transition, `${theme} mobile search label must not animate through the icon`).toBe('0s');
  await rail.evaluate(element => { element.scrollTop = 0; });
  const top = await rail.evaluate(element => ({scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, first: element.firstElementChild?.getBoundingClientRect(), rail: element.getBoundingClientRect()}));
  expect(top.scrollWidth).toBeLessThanOrEqual(top.clientWidth + 1);
  expect(top.first?.top).toBeGreaterThanOrEqual(top.rail.top - 1);
  await page.screenshot({path: testInfo.outputPath(`group-rail-${theme}-390-top.png`), fullPage: false, timeout: 15_000});
  const end = await rail.evaluate(element => {
    element.scrollTop = element.scrollHeight;
    const rows = element.querySelectorAll<HTMLElement>('.person-option');
    const last = rows.item(rows.length - 1);
    const lastRect = last?.getBoundingClientRect();
    const lastText = last?.querySelector<HTMLElement>('.conversation-copy small')?.getBoundingClientRect();
    const exhaustedStatus = element.querySelector<HTMLElement>('.groups-exhausted')?.getBoundingClientRect();
    const railRect = element.getBoundingClientRect();
    return {
      rowCount: rows.length,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      lastBottom: lastRect?.bottom,
      lastTextBottom: lastText?.bottom,
      exhaustedStatusBottom: exhaustedStatus?.bottom,
      railBottom: railRect.bottom,
    };
  });
  expect(end.rowCount).toBeGreaterThan(0);
  expect(end.scrollTop).toBeGreaterThan(0);
  expect(end.scrollTop + end.clientHeight).toBeGreaterThanOrEqual(end.scrollHeight - 1);
  expect(end.lastBottom).toBeLessThanOrEqual(end.railBottom + 1);
  expect(end.lastTextBottom).toBeLessThanOrEqual(end.railBottom - 8);
  if (end.exhaustedStatusBottom !== undefined) expect(end.exhaustedStatusBottom).toBeLessThanOrEqual(end.railBottom + 1);
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
    Object.defineProperty(window, '__denyGroupMicrophone', {configurable: true, writable: true, value: false});
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
    Object.defineProperty(mediaDevices, 'getUserMedia', {configurable: true, value: async () => {
      if ((window as Window & {__denyGroupMicrophone: boolean}).__denyGroupMicrophone) throw new DOMException('denied', 'NotAllowedError');
      return createAudioStream();
    }});
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
  const header = page.locator('.topbar');
  const headerSurface = await header.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(headerSurface, `${theme}/${viewport.width} header surface`).toBe(theme === 'dark' ? 'rgb(32, 44, 59)' : 'rgb(255, 255, 255)');
  const brandContrast = await measureRenderedTextContrast(page.locator('.brand-name'));
  expect(brandContrast.ratio, `${theme}/${viewport.width} brand contrast: ${JSON.stringify(brandContrast)}`).toBeGreaterThanOrEqual(4.5);
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
      const groupTitle = element.querySelector<HTMLElement>('.group-call-card > app-call-profile .call-presentation-copy strong');
      const groupTitleRect = groupTitle?.getBoundingClientRect();
       const select = element.querySelector<HTMLElement>('.group-call-devices .call-select');
       const selectors = Array.from(element.querySelectorAll<HTMLElement>('.group-call-devices .call-select')).map(control => control.getBoundingClientRect());
       const actionRow = element.querySelector<HTMLElement>('.group-call-actions')?.getBoundingClientRect();
       const content = element.querySelector<HTMLElement>('.group-call-content');
       const contentRect = content?.getBoundingClientRect();
    const headerTitle = document.querySelector<HTMLElement>('.chat-header .group-title-row h2')?.getBoundingClientRect();
    const headerAction = document.querySelector<HTMLElement>('.chat-header > .call-button')?.getBoundingClientRect();
       const selectText = select?.querySelector<HTMLElement>('.mat-mdc-select-value-text, .mat-mdc-select-value');
       const action = element.querySelector<HTMLElement>('.group-call-actions .mat-mdc-outlined-button');
       const leaveAction = element.querySelector<HTMLElement>('.group-call-actions button.mat-mdc-outlined-button');
        const endAction = element.querySelector<HTMLElement>('.group-call-active-controls .group-call-end-button:not(.group-call-end-button-labeled)');
        const activeControlRow = element.querySelector<HTMLElement>('.group-call-active-controls')?.getBoundingClientRect();
       const collapse = element.querySelector<HTMLElement>('.group-call-collapse-button');
       const avatar = element.querySelector<HTMLElement>('.call-presentation-avatar');
      const luminance = (color: string): number => (color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(channel => Number(channel) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)) || 0;
       const iconActions = Array.from(element.querySelectorAll<HTMLElement>('app-call-icon-actions .call-presentation-icon-actions button')).map(button => button.getBoundingClientRect());
    const contains = (rect: DOMRect) => rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1 && rect.top >= panelRect.top - 1 && rect.bottom <= panelRect.bottom + 1;
    const style = getComputedStyle(element);
    const panelStyle = getComputedStyle(element);
    const panelAvailableWidth = element.clientWidth - (Number.parseFloat(panelStyle.paddingLeft) || 0) - (Number.parseFloat(panelStyle.paddingRight) || 0);
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      panelScrollWidth: element.scrollWidth,
       panelClientWidth: element.clientWidth,
       contentScrollWidth: content?.scrollWidth,
        contentClientWidth: content?.clientWidth,
        contentScrollHeight: content?.scrollHeight,
        contentClientHeight: content?.clientHeight,
       contentRect: contentRect ? {left: contentRect.left, right: contentRect.right, top: contentRect.top, bottom: contentRect.bottom} : undefined,
      controlsContained: controls.every(control => contains(new DOMRect(control.left, control.top, control.right - control.left, control.bottom - control.top))),
      controlsInViewport: controls.every(control => control.top >= 0 && control.bottom <= window.innerHeight),
      cardContained: !!cardRect && contains(cardRect),
      controlBounds: controls,
      headerTitleContained: !headerTitle || !headerAction || headerTitle.right <= headerAction.left + 1,
      videoContained: !video || contains(video),
      surface: style.backgroundColor,
       text: style.color,
        card: card && cardRect ? {background: getComputedStyle(card).backgroundColor, color: getComputedStyle(card).color, availableWidth: panelAvailableWidth, rect: {left: cardRect.left, right: cardRect.right, top: cardRect.top, bottom: cardRect.bottom}} : undefined,
       groupTitle: groupTitle && groupTitleRect ? {text: groupTitle.textContent?.trim(), left: groupTitleRect.left, right: groupTitleRect.right, top: groupTitleRect.top, bottom: groupTitleRect.bottom, clientHeight: groupTitle.clientHeight, scrollHeight: groupTitle.scrollHeight, whiteSpace: getComputedStyle(groupTitle).whiteSpace, overflow: getComputedStyle(groupTitle).overflow, textOverflow: getComputedStyle(groupTitle).textOverflow} : undefined,
       select: select ? {background: getComputedStyle(select).backgroundColor, color: getComputedStyle(select).color, text: selectText ? getComputedStyle(selectText).color : '', value: selectText?.textContent?.trim() || select.textContent?.trim() || '', width: select.getBoundingClientRect().width} : undefined,
       action: action ? {background: getComputedStyle(action).backgroundColor, color: getComputedStyle(action).color, border: getComputedStyle(action).borderTopColor} : undefined,
       leaveAction: leaveAction ? {label: leaveAction.innerText.trim(), background: getComputedStyle(leaveAction).backgroundColor, color: getComputedStyle(leaveAction).color, border: getComputedStyle(leaveAction).borderTopColor, rect: leaveAction.getBoundingClientRect()} : undefined,
        endAction: endAction ? {background: getComputedStyle(endAction).backgroundColor, color: getComputedStyle(endAction).color, rect: endAction.getBoundingClientRect(), contrast: (() => { const background = luminance(getComputedStyle(endAction).backgroundColor); const foreground = luminance(getComputedStyle(endAction).color); return (Math.max(background, foreground) + .05) / (Math.min(background, foreground) + .05); })()} : undefined,
        activeControlRow: activeControlRow ? {left: activeControlRow.left, right: activeControlRow.right, top: activeControlRow.top, bottom: activeControlRow.bottom} : undefined,
       collapse: collapse ? {rect: collapse.getBoundingClientRect(), width: collapse.getBoundingClientRect().width, height: collapse.getBoundingClientRect().height} : undefined,
       avatar: avatar ? avatar.getBoundingClientRect() : undefined,
      iconActions: iconActions.map(rect => ({left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height})),
    };
  });
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
  expect(metrics.panelScrollWidth).toBeLessThanOrEqual(metrics.panelClientWidth + 1);
   expect(metrics.controlsContained, JSON.stringify({viewport, controls: metrics.controlBounds})).toBeTruthy();
     expect(metrics.controlsInViewport).toBeTruthy();
     expect(metrics.cardContained).toBeTruthy();
     if (!metrics.card) throw new Error('Group call card geometry was not rendered');
     expect(Math.abs((metrics.card.rect.right - metrics.card.rect.left) - Math.min(720, metrics.card.availableWidth))).toBeLessThanOrEqual(8);
      if (!metrics.groupTitle) throw new Error('Group call title was not rendered');
    expect(metrics.groupTitle.text).toBe('Deterministic media group');
    expect(metrics.groupTitle.whiteSpace).toBe('normal');
    expect(metrics.groupTitle.overflow).toBe('visible');
    expect(metrics.groupTitle.textOverflow).toBe('clip');
    expect(metrics.groupTitle.scrollHeight).toBeLessThanOrEqual(metrics.groupTitle.clientHeight + 1);
   expect(metrics.headerTitleContained).toBeTruthy();
    expect(metrics.videoContained).toBeTruthy();
   expect(metrics.surface).not.toBe(metrics.text);
    if (!metrics.card || !metrics.select || !metrics.action) throw new Error('Group call controls were not fully rendered');
     expect(metrics.select.value.length).toBeGreaterThan(0);
      const deviceLabels = await page.locator('.group-call-devices .call-control').all();
     expect(deviceLabels.length).toBe(3);
     for (const label of deviceLabels) {
       const labelContrast = await measureRenderedTextContrast(label);
       expect(labelContrast.ratio, `${theme}/${viewport.width} device label contrast: ${JSON.stringify(labelContrast)}`).toBeGreaterThanOrEqual(4.5);
     }
     if (!metrics.endAction) throw new Error('Group call end action was not rendered');
      expect(metrics.endAction.color).toBe('rgb(255, 255, 255)');
      expect(metrics.endAction.contrast).toBeGreaterThanOrEqual(4.5);
      expect(metrics.endAction.rect.width).toBe(viewport.width <= 760 ? 64 : 68);
      expect(metrics.endAction.rect.height).toBe(viewport.width <= 760 ? 64 : 68);
      expect(metrics.activeControlRow).toBeDefined();
      if (!metrics.leaveAction || !metrics.collapse || !metrics.avatar) throw new Error('Active group call leave/collapse controls were not rendered');
       const leaveContrast = await measureRenderedTextContrast(page.getByRole('button', {name: 'Leave call'}));
       expect(leaveContrast.ratio, `${theme}/${viewport.width} Leave call contrast: ${JSON.stringify(leaveContrast)}`).toBeGreaterThanOrEqual(4.5);
       console.info(`GROUP_CALL_VIEWPORT ${JSON.stringify({theme, viewport, leaveContrast, selectorWidth: metrics.select.width, contentScrollWidth: metrics.contentScrollWidth, contentClientWidth: metrics.contentClientWidth, contentScrollHeight: metrics.contentScrollHeight, contentClientHeight: metrics.contentClientHeight})}`);
      expect(metrics.contentScrollWidth).toBeLessThanOrEqual(metrics.contentClientWidth! + 1);
      expect(metrics.contentRect).toBeDefined();
      for (const control of metrics.controlBounds.filter(control => control.label.includes('Microphone') || control.label.includes('Speaker') || control.label.includes('Presentation'))) {
        expect(control.left, `${theme}/${viewport.width} ${control.label} exceeds call content`).toBeGreaterThanOrEqual(metrics.contentRect!.left - 1);
        expect(control.right, `${theme}/${viewport.width} ${control.label} exceeds call content`).toBeLessThanOrEqual(metrics.contentRect!.right + 1);
      }
      const deviceGeometry = await panel.locator('.group-call-devices').evaluate(element => {
        const host = element as HTMLElement;
        const grid = host.querySelector<HTMLElement>('.call-presentation-devices');
        const selectors = Array.from(host.querySelectorAll<HTMLElement>('.call-select')).map(select => {
          const rect = select.getBoundingClientRect();
          const label = select.closest('.call-control')?.getBoundingClientRect();
          return {left: rect.left, right: rect.right, labelLeft: label?.left, labelRight: label?.right};
        });
        return {hostScrollWidth: host.scrollWidth, hostClientWidth: host.clientWidth, gridScrollWidth: grid?.scrollWidth, gridClientWidth: grid?.clientWidth, selectors};
      });
      expect(deviceGeometry.hostScrollWidth, `${theme}/${viewport.width} device host overflow ${JSON.stringify(deviceGeometry)}`).toBeLessThanOrEqual(deviceGeometry.hostClientWidth + 1);
      expect(deviceGeometry.gridScrollWidth, `${theme}/${viewport.width} device grid overflow ${JSON.stringify(deviceGeometry)}`).toBeLessThanOrEqual((deviceGeometry.gridClientWidth ?? 0) + 1);
      for (const selector of deviceGeometry.selectors) {
        expect(selector.left).toBeGreaterThanOrEqual((selector.labelLeft ?? 0) - 1);
        expect(selector.right).toBeLessThanOrEqual((selector.labelRight ?? 0) + 1);
      }
     expect(metrics.collapse.width).toBeGreaterThanOrEqual(44);
     expect(metrics.collapse.height).toBeGreaterThanOrEqual(44);
     const collapseIntersectsAvatar = metrics.collapse.rect.left < metrics.avatar.right && metrics.collapse.rect.right > metrics.avatar.left && metrics.collapse.rect.top < metrics.avatar.bottom && metrics.collapse.rect.bottom > metrics.avatar.top;
     expect(collapseIntersectsAvatar, `${theme}/${viewport.width} collapse/avatar overlap ${JSON.stringify({collapse: metrics.collapse.rect, avatar: metrics.avatar})}`).toBeFalsy();
     expect(metrics.leaveAction.rect.left).toBeGreaterThanOrEqual(metrics.card.rect.left - 1);
      expect(metrics.leaveAction.rect.right).toBeLessThanOrEqual(metrics.card.rect.right + 1);
       expect(metrics.leaveAction.rect.bottom).toBeLessThanOrEqual(metrics.card.rect.bottom + 1);
        expect(metrics.leaveAction.label).toBe('Leave call');
        expect(metrics.leaveAction.background).not.toBe(metrics.endAction.background);
       const roomEnd = page.getByRole('button', {name: 'End group call for everyone'});
       await roomEnd.hover();
       const roomEndTooltip = page.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface').filter({hasText: 'End group call for everyone'}).last();
       await expect(roomEndTooltip).toBeVisible();
        const roomEndTooltipContrast = await waitForReadableTooltip(roomEndTooltip);
        expect(roomEndTooltipContrast.ratio, `${theme}/${viewport.width} End group call tooltip contrast: ${JSON.stringify(roomEndTooltipContrast)}`).toBeGreaterThanOrEqual(4.5);
        await expect(roomEndTooltip).toHaveCSS('background-color', 'rgb(241, 245, 249)');
        await expect(roomEndTooltip).toHaveCSS('color', 'rgb(23, 32, 51)');
       const roomEndTooltipBounds = await roomEndTooltip.boundingBox();
       expect(roomEndTooltipBounds?.x).toBeGreaterThanOrEqual(0);
       expect(roomEndTooltipBounds?.y).toBeGreaterThanOrEqual(0);
       expect((roomEndTooltipBounds?.x ?? viewport.width) + (roomEndTooltipBounds?.width ?? viewport.width)).toBeLessThanOrEqual(viewport.width);
       expect((roomEndTooltipBounds?.y ?? viewport.height) + (roomEndTooltipBounds?.height ?? viewport.height)).toBeLessThanOrEqual(viewport.height);
       await page.screenshot({path: testInfo.outputPath(`group-call-end-everyone-tooltip-${theme}-${viewport.width}.png`), fullPage: false});
       await page.mouse.move(0, 0);
       expect(metrics.collapse.rect.left).toBeGreaterThanOrEqual(metrics.card.rect.left - 1);
      expect(metrics.collapse.rect.right).toBeLessThanOrEqual(metrics.card.rect.right + 1);
      const collapseButton = page.getByRole('button', {name: 'Minimize group call'});
      await collapseButton.hover();
      const collapseAlignment = await collapseButton.evaluate(button => {
        const control = button.getBoundingClientRect();
        const icon = button.querySelector('zwei-icon')?.getBoundingClientRect();
        const svg = button.querySelector('svg')?.getBoundingClientRect();
        const ripple = button.querySelector('.mat-mdc-button-persistent-ripple')?.getBoundingClientRect();
        return {control: {x: control.x, y: control.y, width: control.width, height: control.height}, icon: icon && {x: icon.x, y: icon.y, width: icon.width, height: icon.height}, svg: svg && {x: svg.x, y: svg.y, width: svg.width, height: svg.height}, ripple: ripple && {x: ripple.x, y: ripple.y, width: ripple.width, height: ripple.height}};
      });
      if (!collapseAlignment.icon || !collapseAlignment.svg) throw new Error(`Missing minimize icon: ${JSON.stringify(collapseAlignment)}`);
      for (const graphic of [collapseAlignment.icon, collapseAlignment.svg]) {
        expect(Math.abs(graphic.x + graphic.width / 2 - (collapseAlignment.control.x + collapseAlignment.control.width / 2)), `${theme}/${viewport.width} horizontal minimize alignment: ${JSON.stringify(collapseAlignment)}`).toBeLessThanOrEqual(1);
        expect(Math.abs(graphic.y + graphic.height / 2 - (collapseAlignment.control.y + collapseAlignment.control.height / 2)), `${theme}/${viewport.width} vertical minimize alignment: ${JSON.stringify(collapseAlignment)}`).toBeLessThanOrEqual(1);
      }
       if (collapseAlignment.ripple) {
         expect(Math.abs(collapseAlignment.ripple.x + collapseAlignment.ripple.width / 2 - (collapseAlignment.control.x + collapseAlignment.control.width / 2))).toBeLessThanOrEqual(1);
         expect(Math.abs(collapseAlignment.ripple.y + collapseAlignment.ripple.height / 2 - (collapseAlignment.control.y + collapseAlignment.control.height / 2))).toBeLessThanOrEqual(1);
       }
       await page.screenshot({path: testInfo.outputPath(`group-call-minimize-hover-${theme}-${viewport.width}.png`), fullPage: false});
    const controlsTop = await page.locator('.group-call-content').evaluate(element => {
      const content = element as HTMLElement;
      content.scrollTop = 0;
      const bounds = content.getBoundingClientRect();
      const selectors = Array.from(element.querySelectorAll<HTMLElement>('.group-call-devices [role="combobox"]')).map(select => select.getBoundingClientRect());
      const actions = document.querySelector<HTMLElement>('.group-call-actions')?.getBoundingClientRect();
      return {scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, bounds, selectors, actions};
    });
    expect(controlsTop.scrollTop).toBe(0);
    expect(controlsTop.selectors).toHaveLength(3);
    expect(controlsTop.selectors[0].top).toBeGreaterThanOrEqual(controlsTop.bounds.top - 1);
    await page.screenshot({path: testInfo.outputPath(`group-call-${theme}-${viewport.width}-controls-top.png`), fullPage: false, timeout: 15_000});
       for (const [label, target] of [['Leave call', page.getByRole('button', {name: 'Leave call'})], ['Minimize group call', page.getByRole('button', {name: 'Minimize group call'})]] as const) {
        await page.mouse.move(0, 0);
        await page.keyboard.press('Tab');
        await target.focus();
       const focusStyle = await target.evaluate(button => ({visible: button.matches(':focus-visible'), outline: getComputedStyle(button).outlineStyle, width: getComputedStyle(button).outlineWidth}));
       expect(focusStyle.visible && focusStyle.outline !== 'none' && Number.parseFloat(focusStyle.width) >= 2, `${theme}/${viewport.width} focus ${JSON.stringify(focusStyle)}`).toBeTruthy();
        if (label === 'Leave call') {
          await page.screenshot({path: testInfo.outputPath(`group-call-leave-focus-${theme}-${viewport.width}.png`), fullPage: false});
        }
        if (label === 'Minimize group call') {
          await page.screenshot({path: testInfo.outputPath(`group-call-collapse-focus-${theme}-${viewport.width}.png`), fullPage: false});
       }
     }
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
    expect(lastSelector.bottom).toBeLessThanOrEqual(controlsEnd.actionRect?.top ?? 0);
   expect(controlsEnd.actionRect).toBeDefined();
   expect(controlsEnd.actionRect?.top).toBeGreaterThanOrEqual(controlsEnd.contentRect.bottom - 1);
       expect(controlsEnd.iconActions).toHaveLength(2);
       expect(metrics.activeControlRow?.left).toBeGreaterThanOrEqual(metrics.card.rect.left - 1);
       expect(metrics.activeControlRow?.right).toBeLessThanOrEqual(metrics.card.rect.right + 1);
       const activeButtons = await panel.locator('.group-call-active-controls > button, .group-call-active-controls app-call-icon-actions button').evaluateAll(buttons => buttons.map(button => {
         const rect = button.getBoundingClientRect();
         return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height};
       }));
       expect(activeButtons).toHaveLength(3);
       expect(activeButtons[0].right).toBeLessThanOrEqual(activeButtons[1].left + 1);
       expect(activeButtons[1].right).toBeLessThanOrEqual(activeButtons[2].left + 1);
       for (const button of activeButtons) {
         expect(button.width).toBeGreaterThanOrEqual(44);
         expect(button.height).toBeGreaterThanOrEqual(44);
         expect(button.top).toBeGreaterThanOrEqual(metrics.activeControlRow?.top ?? 0);
         expect(button.bottom).toBeLessThanOrEqual(metrics.activeControlRow?.bottom ?? 0);
       }
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
       expect(metrics.action.border).toBe('rgb(109, 137, 167)');
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

async function assertGroupPresentationLayout(page: Page, testInfo: import('@playwright/test').TestInfo, theme: 'light' | 'dark', viewport: {width: number; height: number}): Promise<void> {
  await page.setViewportSize(viewport);
  await setTheme(page, theme);
  const metrics = await page.locator('.group-call-panel').evaluate(panel => {
    const card = panel.querySelector<HTMLElement>('.group-call-card');
    const content = panel.querySelector<HTMLElement>('.group-call-content');
    const stage = panel.querySelector<HTMLElement>('.group-call-presentation');
    const stageContent = stage?.parentElement;
    const video = panel.querySelector<HTMLVideoElement>('.group-presentation');
    const firstSelector = panel.querySelector<HTMLElement>('.group-call-devices [role="combobox"]');
    const audioToggle = panel.querySelector<HTMLElement>('.share-audio-toggle');
    const rect = (element: HTMLElement | null) => {
      const bounds = element?.getBoundingClientRect();
      return bounds ? {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height} : undefined;
    };
    const deviceLabels = Array.from(panel.querySelectorAll<HTMLElement>('.group-call-devices .call-control > span')).map(rect);
    const inside = (parent: HTMLElement | null, child: HTMLElement | null) => {
      if (!parent || !child) return false;
      const parentRect = parent.getBoundingClientRect();
      const childRect = child.getBoundingClientRect();
      return childRect.left >= parentRect.left - 1 && childRect.right <= parentRect.right + 1 && childRect.top >= parentRect.top - 1 && childRect.bottom <= parentRect.bottom + 1;
    };
    if (content) content.scrollTop = 0;
    const selectors = Array.from(panel.querySelectorAll<HTMLElement>('.group-call-devices [role="combobox"]')).map(rect);
    return {
      document: {scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth},
      card: rect(card), cardStyle: card ? {width: getComputedStyle(card).width, radius: getComputedStyle(card).borderTopLeftRadius, padding: getComputedStyle(card).padding, sharedWidth: getComputedStyle(document.documentElement).getPropertyValue('--zwei-call-card-max-width').trim(), sharedHeight: getComputedStyle(document.documentElement).getPropertyValue('--zwei-call-card-height').trim(), sharedPadding: getComputedStyle(document.documentElement).getPropertyValue('--zwei-call-card-padding').trim(), sharedRadius: getComputedStyle(document.documentElement).getPropertyValue('--zwei-call-card-radius').trim()} : undefined, content: rect(content), actions: rect(panel.querySelector<HTMLElement>('.group-call-actions')), stage: rect(stage), stageVideoMaxHeight: video ? getComputedStyle(video).maxHeight : '', video: rect(video), firstSelector: rect(firstSelector), selectors, audioToggle: rect(audioToggle), deviceLabels,
      scroll: content ? {scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, scrollWidth: content.scrollWidth, clientWidth: content.clientWidth} : undefined,
       stageInContent: !!content && stageContent?.classList.contains('group-call-content-inner') === true && stageContent?.parentElement === content,
      stageWithinScrollContent: !!content && !!stage && stage.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop + stage.getBoundingClientRect().height <= content.scrollHeight + 1,
      stageHorizontalContainment: !!content && !!stage && stage.getBoundingClientRect().left >= content.getBoundingClientRect().left - 1 && stage.getBoundingClientRect().right <= content.getBoundingClientRect().right + 1,
      videoInStage: inside(stage, video),
      stageBackground: stage ? getComputedStyle(stage).backgroundColor : '',
      videoObjectFit: video ? getComputedStyle(video).objectFit : '',
    };
  });
  expect(metrics.document.scrollWidth, JSON.stringify({theme, viewport, metrics})).toBeLessThanOrEqual(metrics.document.clientWidth + 1);
  expect(metrics.scroll).toBeDefined();
  expect(metrics.scroll?.scrollWidth).toBeLessThanOrEqual((metrics.scroll?.clientWidth ?? 0) + 1);
  expect(metrics.stage, `${theme}/${viewport.width}px presentation stage missing`).toBeDefined();
  expect(metrics.video, `${theme}/${viewport.width}px presentation video missing`).toBeDefined();
  expect(metrics.stageInContent, JSON.stringify({theme, viewport, metrics})).toBeTruthy();
  expect(metrics.stageWithinScrollContent, JSON.stringify({theme, viewport, metrics})).toBeTruthy();
  expect(metrics.stageHorizontalContainment, JSON.stringify({theme, viewport, metrics})).toBeTruthy();
  expect(metrics.videoInStage, JSON.stringify({theme, viewport, metrics})).toBeTruthy();
  expect(metrics.stage?.width).toBeGreaterThan(0);
  expect(metrics.stage?.height).toBeGreaterThan(0);
  expect(metrics.content?.bottom).toBeLessThanOrEqual((metrics.actions?.top ?? 0) + 1);
  expect(metrics.selectors).toHaveLength(3);
  expect(metrics.scroll?.scrollHeight ?? 0).toBeGreaterThanOrEqual(metrics.scroll?.clientHeight ?? 0);
  expect(metrics.audioToggle, `${theme}/${viewport.width}px share-audio toggle must remain in the scrollable call content`).toBeDefined();
  if (viewport.width === 390) {
    expect(metrics.firstSelector?.top).toBeGreaterThanOrEqual((metrics.stage?.bottom ?? 0) - 1);
  }
  for (const selector of metrics.selectors) {
    expect(selector.left).toBeGreaterThanOrEqual((metrics.content?.left ?? 0) - 1);
    expect(selector.right).toBeLessThanOrEqual((metrics.content?.right ?? 0) + 1);
  }
  expect(metrics.actions?.bottom).toBeLessThanOrEqual(viewport.height + 1);
  expect(metrics.videoObjectFit).toBe('contain');
  expect(metrics.cardStyle?.sharedWidth).toBe('720px');
  expect(metrics.cardStyle?.sharedHeight).toBe('clamp(620px, 78vh, 760px)');
  expect(metrics.cardStyle?.sharedPadding).toBe('clamp(22px, 4vw, 42px)');
  expect(metrics.cardStyle?.sharedRadius).toBe('28px');
  expect(metrics.cardStyle?.radius).toBe('28px');
  expect(Number.parseFloat(metrics.cardStyle?.width ?? '0')).toBeLessThanOrEqual(720);
  expect(metrics.stage?.height).toBeGreaterThanOrEqual(viewport.width <= 760 ? 140 : 180);
  expect(metrics.stage?.height).toBeLessThanOrEqual(viewport.width <= 760 ? 190 : 280);
  expect(metrics.stageVideoMaxHeight).toBe('none');
  expect(metrics.stageBackground).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.locator('.group-call-presentation-heading')).toContainText('Shared presentation');
  await page.screenshot({path: testInfo.outputPath(`group-call-presentation-${theme}-${viewport.width}-top.png`), fullPage: false, timeout: 15_000});
  const endMetrics = await page.locator('.group-call-content').evaluate(async element => {
    const content = element as HTMLElement;
    content.scrollTop = content.scrollHeight;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const contentRect = content.getBoundingClientRect();
    const selectors = Array.from(content.querySelectorAll<HTMLElement>('.group-call-devices [role="combobox"]')).map(selector => {
      const bounds = selector.getBoundingClientRect();
      return {top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right};
    });
    const audioToggle = content.querySelector<HTMLElement>('.share-audio-toggle')?.getBoundingClientRect();
    const actions = document.querySelector<HTMLElement>('.group-call-actions')?.getBoundingClientRect();
    return {scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, scrollWidth: content.scrollWidth, clientWidth: content.clientWidth, contentTop: contentRect.top, contentBottom: contentRect.bottom, selectors, audioToggle: audioToggle ? {top: audioToggle.top, bottom: audioToggle.bottom, left: audioToggle.left, right: audioToggle.right} : undefined, actions: actions ? {top: actions.top, bottom: actions.bottom} : undefined};
  });
  expect(endMetrics.scrollTop + endMetrics.clientHeight).toBeGreaterThanOrEqual(endMetrics.scrollHeight - 1);
  expect(endMetrics.scrollWidth).toBeLessThanOrEqual(endMetrics.clientWidth + 1);
  expect(endMetrics.selectors).toHaveLength(3);
  for (const [index, selector] of endMetrics.selectors.entries()) {
    expect(selector.top, `${theme}/${viewport.width}px selector ${index} clipped at content top: ${JSON.stringify({endMetrics, metrics})}`).toBeGreaterThanOrEqual(endMetrics.contentTop - 1);
    expect(selector.bottom, `${theme}/${viewport.width}px selector ${index} clipped at content end: ${JSON.stringify({endMetrics, metrics})}`).toBeLessThanOrEqual(endMetrics.contentBottom + 1);
    expect(selector.bottom, `${theme}/${viewport.width}px selector ${index} overlaps actions: ${JSON.stringify({endMetrics, metrics})}`).toBeLessThanOrEqual(endMetrics.actions?.top ?? 0);
  }
  expect(endMetrics.selectors.at(-1)).toBeDefined();
  expect(endMetrics.audioToggle, `${theme}/${viewport.width}px end-state share-audio toggle missing`).toBeDefined();
  expect(endMetrics.audioToggle?.top).toBeGreaterThanOrEqual(metrics.content?.top ?? 0);
  expect(endMetrics.audioToggle?.bottom, `${theme}/${viewport.width}px end-state share-audio clipping: ${JSON.stringify({endMetrics, metrics})}`).toBeLessThanOrEqual(endMetrics.contentBottom + 1);
  expect(endMetrics.audioToggle?.bottom, `${theme}/${viewport.width}px end-state share-audio overlaps actions: ${JSON.stringify({endMetrics, metrics})}`).toBeLessThanOrEqual(endMetrics.actions?.top ?? 0);
  await page.screenshot({path: testInfo.outputPath(`group-call-presentation-${theme}-${viewport.width}-end.png`), fullPage: false, timeout: 15_000});
}

test('direct call offers and answers connect in the browser UI', async ({browser}, testInfo) => {
  test.setTimeout(180_000);
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
         await expect(alice.getByRole('combobox', {name: 'Screen share quality', exact: true})).toBeVisible();
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
        const deviceRowWidths = await measureCallDeviceRowAlignment(alice.locator('.call-panel-full .call-presentation-devices'));
        console.info(`DIRECT_CALL_DEVICE_ROW_WIDTHS ${JSON.stringify({theme, viewport, deviceRowWidths})}`);
        expect(Math.abs((deviceRowWidths.deviceRowSpan?.width ?? 0) - (deviceRowWidths.qualityAudioControls?.width ?? 0)), `${theme}/${viewport.width}px direct device rows must have matching spans: ${JSON.stringify(deviceRowWidths)}`).toBeLessThanOrEqual(1);
        const metrics = await alice.evaluate(() => {
          const panel = document.querySelector<HTMLElement>('.call-panel-full');
          const card = panel?.querySelector<HTMLElement>('.call-card');
          const callActions = panel?.querySelector<HTMLElement>('.call-actions');
          const profile = panel?.querySelector<HTMLElement>('.call-card > app-call-profile');
          const profileName = profile?.querySelector<HTMLElement>('.call-presentation-copy strong');
          const controls = Array.from(panel?.querySelectorAll<HTMLElement>('.call-devices [role="combobox"], .call-presentation-icon-actions button, .call-actions button') || []);
            const end = panel?.querySelector<HTMLElement>('.direct-call-end-button');
             const actionRow = panel?.querySelector<HTMLElement>('.direct-call-control-row');
             const collapse = panel?.querySelector<HTMLElement>('.call-direct-collapse-button');
             const collapseIcon = collapse?.querySelector<HTMLElement>('zwei-icon');
            const iconActions = Array.from(panel?.querySelectorAll<HTMLElement>('.direct-call-control-row .call-presentation-icon-actions button') || []);
          const cardRect = card?.getBoundingClientRect();
          return {
            theme: document.documentElement.classList.contains('light-theme') ? 'light' : 'dark',
            viewportWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            panelPadding: panel ? {
              top: Number.parseFloat(getComputedStyle(panel).paddingTop),
              right: Number.parseFloat(getComputedStyle(panel).paddingRight),
              bottom: Number.parseFloat(getComputedStyle(panel).paddingBottom),
              left: Number.parseFloat(getComputedStyle(panel).paddingLeft),
            } : undefined,
            card: cardRect ? {left: cardRect.left, right: cardRect.right} : undefined,
            profileSurface: profile ? getComputedStyle(profile).backgroundColor : '',
            profileText: profileName ? getComputedStyle(profileName).color : '',
            callActionsJustifyContent: callActions ? getComputedStyle(callActions).justifyContent : undefined,
            controls: controls.map(control => { const rect = control.getBoundingClientRect(); return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}; }),
            endBottom: end?.getBoundingClientRect().bottom,
            end: end ? {left: end.getBoundingClientRect().left, right: end.getBoundingClientRect().right, top: end.getBoundingClientRect().top, bottom: end.getBoundingClientRect().bottom, width: end.getBoundingClientRect().width, height: end.getBoundingClientRect().height} : undefined,
            actionRow: actionRow ? {left: actionRow.getBoundingClientRect().left, right: actionRow.getBoundingClientRect().right, center: actionRow.getBoundingClientRect().left + actionRow.getBoundingClientRect().width / 2} : undefined,
            iconActions: iconActions.map(button => { const bounds = button.getBoundingClientRect(); return {width: bounds.width, height: bounds.height, radius: getComputedStyle(button).borderRadius}; }),
             collapse: collapse ? {left: collapse.getBoundingClientRect().left, right: collapse.getBoundingClientRect().right, top: collapse.getBoundingClientRect().top, bottom: collapse.getBoundingClientRect().bottom} : undefined,
             collapseIcon: collapseIcon ? {left: collapseIcon.getBoundingClientRect().left, right: collapseIcon.getBoundingClientRect().right, top: collapseIcon.getBoundingClientRect().top, bottom: collapseIcon.getBoundingClientRect().bottom} : undefined,
            collapseStyle: collapse ? {color: getComputedStyle(collapse).color, background: getComputedStyle(collapse).backgroundColor, borderColor: getComputedStyle(collapse).borderTopColor, borderStyle: getComputedStyle(collapse).borderTopStyle, radius: getComputedStyle(collapse).borderRadius} : undefined,
            viewportHeight: window.innerHeight,
          };
        });
        const fullCallGutter = viewport.width <= 760 ? 12 : Math.min(36, Math.max(16, viewport.width * .02));
        const fullCallVerticalPadding = viewport.width <= 760 ? 24 : fullCallGutter;
        expect(metrics.panelPadding?.top).toBeCloseTo(fullCallVerticalPadding, 1);
        expect(metrics.panelPadding?.bottom).toBeCloseTo(fullCallVerticalPadding, 1);
        expect(metrics.panelPadding?.left).toBeCloseTo(fullCallGutter, 1);
        expect(metrics.panelPadding?.right).toBeCloseTo(fullCallGutter, 1);
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
        expect(metrics.card).toBeDefined();
        expect(metrics.controls).not.toHaveLength(0);
        expect(metrics.callActionsJustifyContent).toBe('flex-end');
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
        expect(metrics.end?.width).toBeGreaterThanOrEqual(64);
        expect(metrics.end?.height).toBeGreaterThanOrEqual(64);
        expect(metrics.iconActions).toHaveLength(2);
        for (const button of metrics.iconActions) {
          expect(button.width).toBeGreaterThanOrEqual(48);
          expect(button.height).toBeGreaterThanOrEqual(48);
          expect(button.radius).toBe('50%');
        }
        expect(metrics.actionRow).toBeDefined();
        expect(Math.abs(((metrics.end?.left || 0) + (metrics.end?.right || 0)) / 2 - (metrics.actionRow?.center || 0))).toBeLessThanOrEqual(2);
        expect(metrics.collapse).toBeDefined();
        expect((metrics.collapse?.right || 0) - (metrics.collapse?.left || 0)).toBeGreaterThanOrEqual(44);
        expect(metrics.collapseIcon).toBeDefined();
        const collapseCenterX = ((metrics.collapse?.left || 0) + (metrics.collapse?.right || 0)) / 2;
        const collapseCenterY = ((metrics.collapse?.top || 0) + (metrics.collapse?.bottom || 0)) / 2;
        const iconCenterX = ((metrics.collapseIcon?.left || 0) + (metrics.collapseIcon?.right || 0)) / 2;
        const iconCenterY = ((metrics.collapseIcon?.top || 0) + (metrics.collapseIcon?.bottom || 0)) / 2;
        expect(Math.abs(iconCenterX - collapseCenterX), `${theme}/${viewport.width}px direct minimize icon horizontal center`).toBeLessThanOrEqual(2);
        expect(Math.abs(iconCenterY - collapseCenterY), `${theme}/${viewport.width}px direct minimize icon vertical center`).toBeLessThanOrEqual(2);
        expect(metrics.collapseStyle?.borderStyle).toBe('solid');
        expect(metrics.collapseStyle?.background).not.toBe('rgba(0, 0, 0, 0)');
        console.log(`DIRECT_MINIMIZE_RENDERED ${JSON.stringify({theme, viewport, style: metrics.collapseStyle, bounds: metrics.collapse})}`);
        await alice.screenshot({path: testInfo.outputPath(`direct-call-active-${theme}-${viewport.width}.png`), fullPage: false});
      }
    }

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(alice, theme);
      await alice.setViewportSize({width: 1440, height: 900});
      const minimize = alice.getByRole('button', {name: 'Minimize call'});
      await minimize.hover();
      const tooltip = alice.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface').filter({hasText: 'Minimize call'}).last();
      await expect(tooltip).toBeVisible();
       const tooltipContrast = await waitForReadableTooltip(tooltip);
      expect(tooltipContrast.ratio, `${theme} desktop minimize tooltip contrast: ${JSON.stringify(tooltipContrast)}`).toBeGreaterThanOrEqual(4.5);
      const tooltipRect = await tooltip.boundingBox();
      expect(tooltipRect?.x).toBeGreaterThanOrEqual(0);
      expect((tooltipRect?.x ?? 1440) + (tooltipRect?.width ?? 1440)).toBeLessThanOrEqual(1440);
      await alice.screenshot({path: testInfo.outputPath(`direct-call-minimize-tooltip-${theme}-1440.png`), fullPage: false});
      await alice.locator('.call-quality-trigger').focus();
      for (let step = 0; step < 3; step++) await alice.keyboard.press('Shift+Tab');
      await expect(minimize).toBeFocused();
      const focus = await minimize.evaluate(element => getComputedStyle(element).outlineStyle);
      expect(focus).not.toBe('none');
      await alice.screenshot({path: testInfo.outputPath(`direct-call-minimize-focus-${theme}-1440.png`), fullPage: false});

      await alice.setViewportSize({width: 390, height: 844});
      await minimize.hover();
      const mobileTooltip = alice.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface').filter({hasText: 'Minimize call'}).last();
      await expect(mobileTooltip).toBeVisible();
       const mobileTooltipContrast = await waitForReadableTooltip(mobileTooltip);
      expect(mobileTooltipContrast.ratio, `${theme} mobile minimize tooltip contrast: ${JSON.stringify(mobileTooltipContrast)}`).toBeGreaterThanOrEqual(4.5);
      const mobileTooltipBounds = await mobileTooltip.boundingBox();
      expect(mobileTooltipBounds?.x).toBeGreaterThanOrEqual(0);
      expect(mobileTooltipBounds?.y).toBeGreaterThanOrEqual(0);
      expect((mobileTooltipBounds?.x ?? 390) + (mobileTooltipBounds?.width ?? 390)).toBeLessThanOrEqual(390);
      expect((mobileTooltipBounds?.y ?? 844) + (mobileTooltipBounds?.height ?? 844)).toBeLessThanOrEqual(844);
      await alice.screenshot({path: testInfo.outputPath(`direct-call-minimize-tooltip-${theme}-390.png`), fullPage: false});
      await minimize.focus();
      await alice.keyboard.press('Tab');
      await alice.keyboard.press('Shift+Tab');
      await expect(minimize).toBeFocused();
      expect(await minimize.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
      await alice.screenshot({path: testInfo.outputPath(`direct-call-minimize-focus-${theme}-390.png`), fullPage: false});
    }

    const shareAudioOption = alice.getByRole('checkbox', {name: 'Share audio'});
    const endCall = alice.getByRole('button', {name: 'End call'});
    await expect(shareAudioOption).toBeVisible();
    await expect(shareAudioOption).toBeEnabled();
    await setTheme(alice, 'light');
    await setTheme(alice, 'light');
    await alice.setViewportSize({width: 390, height: 844});
    await expect(shareAudioOption).toBeVisible();
    const audioQualityGeometry = await alice.locator('.call-quality-trigger, .share-audio-toggle').evaluateAll(elements => {
      const bounds = elements.map(element => element.getBoundingClientRect());
      return bounds.map(rect => ({left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}));
    });
    expect(audioQualityGeometry).toHaveLength(2);
    expect(Math.abs(audioQualityGeometry[0].top - audioQualityGeometry[1].top)).toBeLessThanOrEqual(6);
    await alice.locator('.call-quality-trigger').focus();
    await alice.keyboard.press('Tab');
    await shareAudioOption.focus();
    await expect(shareAudioOption).toBeFocused();
    expect(await shareAudioOption.getAttribute('aria-label')).toBe('Share audio');
    const audioOffColor = await alice.locator('.share-audio-toggle').evaluate(element => getComputedStyle(element).color);
    await shareAudioOption.check();
    const audioOnColor = await alice.locator('.share-audio-toggle').evaluate(element => getComputedStyle(element).color);
    expect(audioOnColor).not.toBe(audioOffColor);
    await expect(alice.locator('.share-audio-label')).toHaveText('Share audio');
    expect(await shareAudioOption.getAttribute('aria-label')).toBe('Share audio');
    await alice.screenshot({path: testInfo.outputPath('direct-call-audio-option-checked.png'), fullPage: false});
    await setTheme(alice, 'dark');
    await alice.setViewportSize({width: 1440, height: 900});
    await expect(shareAudioOption).toBeChecked();
    await expect(alice.locator('.share-audio-label')).toHaveText('Share audio');
    await alice.screenshot({path: testInfo.outputPath('direct-call-audio-option-checked-dark-desktop.png'), fullPage: false});
    await setTheme(alice, 'light');
    await alice.setViewportSize({width: 390, height: 844});
    await shareAudioOption.focus();
    await expect(shareAudioOption).toBeFocused();
    const audioFocusOutline = await alice.locator('.share-audio-toggle').evaluate(element => getComputedStyle(element).outlineStyle);
    expect(audioFocusOutline).not.toBe('none');
    const audioFocusGeometry = await alice.locator('.share-audio-toggle').evaluate(element => {
      const rect = element.getBoundingClientRect();
      const row = element.closest<HTMLElement>('.call-quality-audio-row');
      const content = element.closest<HTMLElement>('.call-card-content');
      const rowRect = row?.getBoundingClientRect();
      const contentRect = content?.getBoundingClientRect();
      return {
        toggle: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom},
        row: rowRect && {left: rowRect.left, right: rowRect.right, top: rowRect.top, bottom: rowRect.bottom, scrollWidth: row?.scrollWidth, clientWidth: row?.clientWidth},
        content: contentRect && {left: contentRect.left, right: contentRect.right, scrollWidth: content?.scrollWidth, clientWidth: content?.clientWidth, overflowX: getComputedStyle(content!).overflowX},
        outline: {style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth, offset: getComputedStyle(element).outlineOffset},
      };
    });
    console.log(`DIRECT_AUDIO_FOCUS_GEOMETRY ${JSON.stringify(audioFocusGeometry)}`);
    expect(audioFocusGeometry.row).toBeDefined();
    expect(audioFocusGeometry.content).toBeDefined();
    const initialAudioFocusClip = await measureShareAudioFocusClip(alice.locator('.share-audio-toggle'));
    expect(initialAudioFocusClip.ring.left).toBeGreaterThanOrEqual(initialAudioFocusClip.clip.left - 1);
    expect(initialAudioFocusClip.ring.right).toBeLessThanOrEqual(initialAudioFocusClip.clip.right + 1);
    expect(initialAudioFocusClip.ring.top).toBeGreaterThanOrEqual(initialAudioFocusClip.clip.top - 1);
    expect(initialAudioFocusClip.ring.bottom).toBeLessThanOrEqual(initialAudioFocusClip.clip.bottom + 1);
    await expect(alice.locator('.share-audio-description')).toContainText(/system audio will be included/i);
    await expect(alice.locator('.share-audio-toggle')).toHaveAttribute('title', /system audio/i);
    await expect(shareAudioOption).toHaveAttribute('aria-description', /system audio will be included/i);
    await expect(alice.locator('.share-audio-toggle')).toHaveAttribute('title', /system audio/i);
    await alice.screenshot({path: testInfo.outputPath('direct-call-audio-option-keyboard-focus.png'), fullPage: false});
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
        await setTheme(alice, theme);
        await alice.setViewportSize(viewport);
        await shareAudioOption.focus();
        const focusBounds = await alice.locator('.share-audio-toggle').evaluate(element => {
          const rect = element.getBoundingClientRect();
          const content = element.closest<HTMLElement>('.call-card-content');
          const contentRect = content?.getBoundingClientRect();
          const style = getComputedStyle(element);
          const ringInset = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
          return {ringLeft: rect.left - ringInset, ringRight: rect.right + ringInset, ringTop: rect.top - ringInset, ringBottom: rect.bottom + ringInset, content: contentRect && {left: contentRect.left, right: contentRect.right, top: contentRect.top, bottom: contentRect.bottom, scrollWidth: content?.scrollWidth, clientWidth: content?.clientWidth}, outlineStyle: style.outlineStyle};
        });
        expect(focusBounds.outlineStyle).not.toBe('none');
        expect(focusBounds.content).toBeDefined();
        expect(focusBounds.ringLeft, `${theme}/${viewport.width}px audio focus ring clips left: ${JSON.stringify(focusBounds)}`).toBeGreaterThanOrEqual((focusBounds.content?.left ?? 0) - 1);
        expect(focusBounds.ringRight, `${theme}/${viewport.width}px audio focus ring clips right: ${JSON.stringify(focusBounds)}`).toBeLessThanOrEqual((focusBounds.content?.right ?? 0) + 1);
        const checkedClip = await measureShareAudioFocusClip(alice.locator('.share-audio-toggle'));
        expect(checkedClip.ring.left, `${theme}/${viewport.width}px checked focus ring clips left: ${JSON.stringify(checkedClip)}`).toBeGreaterThanOrEqual(checkedClip.clip.left - 1);
        expect(checkedClip.ring.right, `${theme}/${viewport.width}px checked focus ring clips right: ${JSON.stringify(checkedClip)}`).toBeLessThanOrEqual(checkedClip.clip.right + 1);
        expect(checkedClip.ring.top, `${theme}/${viewport.width}px checked focus ring clips top: ${JSON.stringify(checkedClip)}`).toBeGreaterThanOrEqual(checkedClip.clip.top - 1);
        expect(checkedClip.ring.bottom, `${theme}/${viewport.width}px checked focus ring clips bottom: ${JSON.stringify(checkedClip)}`).toBeLessThanOrEqual(checkedClip.clip.bottom + 1);
        await shareAudioOption.uncheck();
        await expect(shareAudioOption).not.toBeChecked();
        await shareAudioOption.focus();
        const uncheckedClip = await measureShareAudioFocusClip(alice.locator('.share-audio-toggle'));
        expect(uncheckedClip.ring.left, `${theme}/${viewport.width}px unchecked focus ring clips left: ${JSON.stringify(uncheckedClip)}`).toBeGreaterThanOrEqual(uncheckedClip.clip.left - 1);
        expect(uncheckedClip.ring.right, `${theme}/${viewport.width}px unchecked focus ring clips right: ${JSON.stringify(uncheckedClip)}`).toBeLessThanOrEqual(uncheckedClip.clip.right + 1);
        expect(uncheckedClip.ring.top, `${theme}/${viewport.width}px unchecked focus ring clips top: ${JSON.stringify(uncheckedClip)}`).toBeGreaterThanOrEqual(uncheckedClip.clip.top - 1);
        expect(uncheckedClip.ring.bottom, `${theme}/${viewport.width}px unchecked focus ring clips bottom: ${JSON.stringify(uncheckedClip)}`).toBeLessThanOrEqual(uncheckedClip.clip.bottom + 1);
        if (viewport.width === 390) await alice.screenshot({path: testInfo.outputPath(`direct-call-audio-unchecked-focus-${theme}-390.png`), fullPage: false});
        await shareAudioOption.check();
        if (viewport.width === 390) await alice.screenshot({path: testInfo.outputPath(`direct-call-audio-focus-${theme}-390.png`), fullPage: false});
      }
    }
    await setTheme(alice, 'light');
    await alice.setViewportSize({width: 390, height: 844});

    const unsupportedContext = await browser.newContext({viewport: {width: 390, height: 844}});
    await unsupportedContext.grantPermissions(['microphone'], {origin: 'https://chat.localhost'});
    const unsupportedPage = await unsupportedContext.newPage();
    await register(unsupportedPage, uniqueEmail('no-screen-capture'), 'No Screen Capture');
    await unsupportedPage.evaluate(() => Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {configurable: true, value: undefined}));
    await endCall.click();
    await expect(bob.getByText('Call ended.')).toBeVisible();
    await unsupportedPage.getByPlaceholder('Name or email').fill(aliceEmail);
    await unsupportedPage.locator('.search-result').filter({hasText: aliceEmail}).click();
    await unsupportedPage.getByRole('button', {name: 'Start audio call'}).click();
    await expect(alice.getByText('Incoming audio call.')).toBeVisible();
    await alice.getByRole('button', {name: 'Accept'}).click();
    const unsupportedCheckbox = unsupportedPage.getByRole('checkbox', {name: 'Share audio'});
    await expect(unsupportedCheckbox).toBeVisible();
    await expect(unsupportedCheckbox).toBeDisabled();
    await expect(unsupportedPage.locator('#call-share-audio-unavailable-status')).toContainText(/screen sharing is not supported/i);
    await expect(unsupportedCheckbox).toHaveAttribute('aria-description', /screen sharing is not supported/i);
    const unavailableReason = unsupportedPage.locator('.share-audio-unavailable-reason');
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(unsupportedPage, theme);
      for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 768}, {width: 390, height: 844}]) {
        await unsupportedPage.setViewportSize(viewport);
        await expect(unsupportedCheckbox).toBeDisabled();
        await expect(unavailableReason).toBeVisible();
        await expect(unavailableReason).toContainText(/screen sharing is not supported/i);
        const geometry = await unavailableReason.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const qualityRow = element.closest('.call-quality-audio-row')?.getBoundingClientRect();
          const controls = element.closest('.call-quality-audio-row')?.querySelector<HTMLElement>('.share-audio-toggle')?.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, row: qualityRow && {left: qualityRow.left, right: qualityRow.right, bottom: qualityRow.bottom}, control: controls && {bottom: controls.bottom}, color: style.color, background: getComputedStyle(element.closest('.call-card') ?? element).backgroundColor, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth};
        });
        expect(geometry.width, JSON.stringify(geometry)).toBeGreaterThan(0);
        expect(geometry.left).toBeGreaterThanOrEqual((geometry.row?.left ?? 0) - 1);
        expect(geometry.right).toBeLessThanOrEqual((geometry.row?.right ?? viewport.width) + 1);
        expect(geometry.top).toBeGreaterThanOrEqual((geometry.control?.bottom ?? 0) - 1);
        expect(geometry.bottom).toBeLessThanOrEqual((geometry.row?.bottom ?? viewport.height) + 1);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
        const contrast = await measureRenderedTextContrast(unavailableReason);
        expect(contrast.ratio, `${theme}/${viewport.width}px unavailable reason contrast ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
        await unsupportedPage.screenshot({path: testInfo.outputPath(`direct-call-audio-unsupported-${theme}-${viewport.width}.png`), fullPage: false});
      }
    }
    await unsupportedPage.getByRole('button', {name: 'End call'}).click();
    await expect(alice.getByText('Call ended.')).toBeVisible();
    await unsupportedContext.close();

    await expect(alice.getByRole('button', {name: 'Start audio call'})).toBeVisible();
  } finally {
    await Promise.allSettled([aliceContext.close(), bobContext.close()]);
  }
});

test('shows group members who are typing by name and tracks each member independently', async ({browser}, testInfo) => {
  test.setTimeout(180_000);
  const participants = [
    {name: 'Typing owner', email: uniqueEmail('typing-owner')},
    {name: 'Alice', email: uniqueEmail('typing-alice')},
    {name: 'Bob', email: uniqueEmail('typing-bob')},
    {name: 'Carol', email: uniqueEmail('typing-carol')},
  ];
  const contexts = await Promise.all(participants.map(() => browser.newContext({viewport: {width: 1440, height: 900}})));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const [owner, alice, bob, carol] = pages;
  if (!owner || !alice || !bob || !carol) throw new Error('Group typing browser pages were not created');

  try {
    for (const [index, page] of pages.entries()) await register(page, participants[index].email, participants[index].name);
    await Promise.all(pages.map(waitForLiveConnection));
    const ownerToken = await authenticatedToken(contexts[0], participants[0].email, 'typing-owner');
    const memberIDs = await Promise.all(participants.slice(1).map(user => userID(contexts[0], ownerToken, user.email)));
    const created = await contexts[0].request.post(`${chatBase}/api/chat/groups`, {
      headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`},
      data: {name: 'Typing group', member_ids: memberIDs},
    });
    expect(created.status()).toBe(201);

    for (const page of pages) {
      await page.reload();
      const group = page.locator('.person-option').filter({hasText: 'Typing group'});
      await expect(group).toBeVisible({timeout: 10_000});
      await group.click();
    }
    const typingIndicator = owner.locator('.typing-indicator');
    const aliceComposer = alice.getByPlaceholder('Write a message…');
    const bobComposer = bob.getByPlaceholder('Write a message…');
    const carolComposer = carol.getByPlaceholder('Write a message…');
    await aliceComposer.fill('typing');
    await expect(typingIndicator).toHaveText('Alice is typing…');
    await bobComposer.fill('typing');
    await expect(typingIndicator).toHaveText('Alice and Bob are typing…');
    await carolComposer.fill('typing');
    await expect(typingIndicator).toHaveText('Alice, Bob, and Carol are typing…');

    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
        await owner.setViewportSize(viewport);
        await setTheme(owner, theme);
        await expect(typingIndicator).toHaveText('Alice, Bob, and Carol are typing…');
        const typingContrast = await measureRenderedTextContrast(typingIndicator);
        expect(typingContrast.ratio, `${theme}/${viewport.width}px group typing text contrast: ${JSON.stringify(typingContrast)}`).toBeGreaterThanOrEqual(4.5);
        const geometry = await typingIndicator.evaluate(element => {
          const indicator = element.getBoundingClientRect();
          const header = element.closest('header')?.getBoundingClientRect();
          return {left: indicator.left, right: indicator.right, top: indicator.top, bottom: indicator.bottom, header: header && {left: header.left, right: header.right, top: header.top, bottom: header.bottom}, viewportWidth: window.innerWidth};
        });
        expect(geometry.viewportWidth).toBe(viewport.width);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
        expect(geometry.header).toBeDefined();
        expect(geometry.top).toBeGreaterThanOrEqual(geometry.header?.top ?? 0);
        expect(geometry.bottom).toBeLessThanOrEqual((geometry.header?.bottom ?? 0) + 1);
        await owner.screenshot({path: testInfo.outputPath(`group-typing-${theme}-${viewport.width}.png`), fullPage: false});
        await owner.waitForTimeout(1_250);
        await aliceComposer.fill(`typing ${theme} ${viewport.width}`);
        await bobComposer.fill(`typing ${theme} ${viewport.width}`);
        await carolComposer.fill(`typing ${theme} ${viewport.width}`);
      }
    }

    await aliceComposer.fill('');
    await expect(typingIndicator).toHaveText('Bob and Carol are typing…');
    await bobComposer.fill('');
    await expect(typingIndicator).toHaveText('Carol is typing…');
    await carolComposer.fill('');
    await expect(typingIndicator).toHaveCount(0);
    await owner.screenshot({path: testInfo.outputPath('group-typing-stopped.png'), fullPage: false});
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
  }
});

test('register, create conversation, and deliver a message', async ({ browser }, testInfo) => {
  // Active-call acceptance matrix: light/dark at 2560, 1440, 1024, and 390x844; assert mobile picker containment and end-of-content device access.
  test.setTimeout(240_000);
  const aliceEmail = uniqueEmail('alice');
  const bobEmail = uniqueEmail('bob');
  const charlieEmail = uniqueEmail('charlie');
  const aliceDisplayName = 'Alice With A Long Display Name For Responsive Calls';
  const bobDisplayName = 'Bob With A Long Display Name For Responsive Calls';
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
   await register(alice, aliceEmail, aliceDisplayName);
   await register(bob, bobEmail, bobDisplayName);
   await register(charlie, charlieEmail, 'Charlie');
   await Promise.all([waitForLiveConnection(alice), waitForLiveConnection(bob), waitForLiveConnection(charlie)]);
   await expect(alice.getByRole('button', { name: 'Account menu' })).toBeVisible();
    await expect(alice.locator('.conversation-rail')).toBeVisible();
    await expect(alice.getByText(/is typing/)).not.toBeVisible();
    await expect(alice.locator('.call-panel')).toHaveCount(0);
    await expect(alice.locator('.chat-empty')).toBeVisible();
    // Idle/no-selected-conversation sanity matrix: both themes, desktop and mobile.
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(alice, theme);
      for (const viewport of [{width: 2560, height: 1440}, {width: 390, height: 844}]) {
        await alice.setViewportSize(viewport);
        const context = `${theme}/${viewport.width}px idle Home without a selected conversation`;
        await expect(alice.locator('.call-panel')).toHaveCount(0);
        await expect(alice.locator('.conversation-rail')).toBeVisible();
        await expect(alice.locator('.person-option')).toHaveCount(0);
        if (viewport.width > 760) await expect(alice.locator('.chat-empty')).toBeVisible();
        else await expect(alice.locator('.chat-panel')).not.toBeVisible();
        const overflow = await alice.evaluate(() => ({documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth}));
        expect(overflow.documentWidth, context).toBeLessThanOrEqual(overflow.viewportWidth + 1);
        await alice.screenshot({path: testInfo.outputPath(`idle-empty-${theme}-${viewport.width}.png`), fullPage: false});
      }
    }
    await alice.setViewportSize(desktop.viewport);
    await setTheme(alice, 'dark');

    const peopleSearch = alice.getByPlaceholder('Name or email');
   await peopleSearch.fill(bobEmail);
   const bobResult = alice.locator('.search-result').filter({hasText: bobEmail});
   await expect(bobResult).toBeVisible();
   // Open-search acceptance matrix: light/dark × 2560x1440, 1440x900, 1024x900, 390x844.
   for (const theme of ['light', 'dark'] as const) {
     await setTheme(alice, theme);
     for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
       await alice.setViewportSize(viewport);
       await expect(bobResult).toBeVisible();
       const geometry = await alice.locator('.search-results').evaluate(results => {
         const rail = results.closest<HTMLElement>('.conversation-rail');
         const field = rail?.querySelector<HTMLElement>('.search-field');
         const input = field?.querySelector<HTMLInputElement>('input');
         const result = results.querySelector<HTMLElement>('.search-result');
         const label = rail?.querySelector<HTMLElement>('.rail-label');
         const outline = field?.querySelector<HTMLElement>('.mdc-notched-outline__trailing');
         if (!rail || !field || !input || !result || !label || !outline) throw new Error('Open people search is incomplete');
         const rect = (element: Element) => {
           const box = element.getBoundingClientRect();
           return {left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height};
         };
         return {
           input: rect(input), field: rect(field), results: rect(results), result: rect(result), label: rect(label), rail: rect(rail),
           documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
           resultsWidth: results.scrollWidth, resultsClientWidth: results.clientWidth,
           resultWidth: result.scrollWidth, resultClientWidth: result.clientWidth,
           surface: getComputedStyle(results).backgroundColor,
           border: getComputedStyle(results).borderTopWidth,
           borderStyle: getComputedStyle(results).borderTopStyle,
           outlineBorder: getComputedStyle(outline).borderTopWidth,
         };
       });
       const context = `${theme}/${viewport.width}px open search: ${JSON.stringify(geometry)}`;
       expect(geometry.documentWidth, context).toBeLessThanOrEqual(geometry.viewportWidth + 1);
       expect(geometry.resultsWidth, context).toBeLessThanOrEqual(geometry.resultsClientWidth + 1);
       expect(geometry.resultWidth, context).toBeLessThanOrEqual(geometry.resultClientWidth + 1);
       expect(geometry.input.width, context).toBeGreaterThan(0);
       expect(geometry.input.left, context).toBeGreaterThanOrEqual(geometry.field.left - 1);
       expect(geometry.input.right, context).toBeLessThanOrEqual(geometry.field.right + 1);
       expect(geometry.field.bottom, context).toBeLessThanOrEqual(geometry.results.top + 5);
       expect(geometry.result.top, context).toBeGreaterThanOrEqual(geometry.results.top - 1);
       expect(geometry.result.bottom, context).toBeLessThanOrEqual(geometry.results.bottom + 1);
       expect(geometry.results.bottom, context).toBeLessThanOrEqual(geometry.label.top + 1);
       expect(geometry.results.left, context).toBeGreaterThanOrEqual(geometry.rail.left - 1);
        expect(geometry.results.right, context).toBeLessThanOrEqual(geometry.rail.right + 1);
        expect(geometry.result.left, context).toBeGreaterThanOrEqual(geometry.results.left - 1);
        expect(geometry.result.right, context).toBeLessThanOrEqual(geometry.results.right + 1);
       expect(geometry.result.top, context).toBeGreaterThanOrEqual(0);
       expect(geometry.result.bottom, context).toBeLessThanOrEqual(viewport.height + 1);
        expect(geometry.borderStyle, context).toBe('solid');
        expect(Number.parseFloat(geometry.border), context).toBeGreaterThan(0);
        expect(Number.parseFloat(geometry.outlineBorder), context).toBeGreaterThan(0);
         expect(geometry.surface, context).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(38, 53, 70)');
         const searchBorderColor = await alice.locator('.search-results').evaluate(element => getComputedStyle(element).borderTopColor);
         expect(searchBorderColor, context).toBe(theme === 'light' ? 'rgb(220, 227, 239)' : 'rgb(42, 57, 74)');
        const searchAdornment = alice.locator('.search-field zwei-icon');
        const searchAdornmentBox = await searchAdornment.boundingBox();
        expect(searchAdornmentBox, context).not.toBeNull();
        expect((searchAdornmentBox?.x ?? Number.POSITIVE_INFINITY) + (searchAdornmentBox?.width ?? 0), context).toBeLessThanOrEqual(geometry.input.left);
        const adornmentContrast = await measureRenderedTextContrastAtSurface(searchAdornment);
        expect(adornmentContrast.ratio, `${context} search icon contrast: ${JSON.stringify(adornmentContrast)}`).toBeGreaterThanOrEqual(3);
        await peopleSearch.focus();
        await peopleSearch.press('Home');
        await peopleSearch.press('End');
        const queryViewport = await peopleSearch.evaluate(input => ({
          value: input.value,
          selectionStart: input.selectionStart,
          scrollLeft: input.scrollLeft,
          scrollWidth: input.scrollWidth,
          clientWidth: input.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth,
        }));
        expect(queryViewport.value, context).toBe(bobEmail);
        expect(queryViewport.selectionStart, context).toBe(queryViewport.value.length);
        expect(queryViewport.documentWidth, context).toBeLessThanOrEqual(queryViewport.viewportWidth + 1);
        if (queryViewport.scrollWidth > queryViewport.clientWidth + 1) {
          expect(queryViewport.scrollLeft, `${context} long query should scroll inside the input: ${JSON.stringify(queryViewport)}`).toBeGreaterThan(0);
        }
        for (const text of [bobResult.locator('strong'), bobResult.locator('small'), peopleSearch]) {
         const contrast = await measureRenderedTextContrastAtSurface(text);
         expect(contrast.ratio, `${context} text contrast: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
       }
       await alice.screenshot({path: testInfo.outputPath(`search-results-open-${theme}-${viewport.width}.png`), fullPage: false});
     }
   }
   await alice.setViewportSize(desktop.viewport);
   await setTheme(alice, 'dark');
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
    await expect(bob.getByText(new RegExp(`${aliceDisplayName} is typing…`))).toBeVisible();
    await expect(bob.getByText(new RegExp(`${aliceDisplayName} is typing…`))).not.toBeVisible({ timeout: 3_000 });

   await bob.setViewportSize({width: 390, height: 844});
   await bob.getByRole('button', {name: 'Back to chats'}).click();
   await bob.setViewportSize(desktop.viewport);

      await expect(alice.getByRole('button', {name: 'Start audio call'})).toBeEnabled();
      await alice.getByRole('button', {name: 'Start audio call'}).click();
      await expect(alice.getByText('Ringing...')).toBeVisible();
      await expect(bob.getByText('Incoming audio call.')).toBeVisible();
      // Outgoing notification acceptance matrix: light/dark × 2560, 1440, 1024, and 390px.
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(alice, theme);
        for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
          await alice.setViewportSize(viewport);
          const outgoingPanel = alice.locator('.call-panel:not(.call-panel-full)');
          const outgoingCard = outgoingPanel.locator('.call-card');
          await expect(outgoingCard).toBeVisible();
          const outgoingSurface = await measureCallNotificationSurface(alice, '.call-card');
          const context = `${theme}/${viewport.width}px outgoing-call notification: ${JSON.stringify(outgoingSurface)}`;
          const expectedSurface = theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(32, 44, 59)';
          expect(outgoingSurface.panelSurface, context).toBe(expectedSurface);
          expect(outgoingSurface.cardSurface, context).toBe(expectedSurface);
          expect(outgoingSurface.actionSurface, context).toBe(expectedSurface);
          expectCallNotificationLayout(outgoingSurface, context, viewport);
          expect(outgoingSurface.buttons, context).toHaveLength(1);
          if (viewport.width === 390) expectLongCallProfileNameTruncated(outgoingSurface, context);
          const cancelContrast = await measureRenderedTextContrastAtSurface(outgoingCard.getByRole('button', {name: 'Cancel'}));
          expect(cancelContrast.ratio, `${context} Cancel contrast: ${JSON.stringify(cancelContrast)}`).toBeGreaterThanOrEqual(4.5);
          await expect(alice.locator('.message-history')).toBeVisible();
          await expect(alice.getByLabel('Message composer')).toBeVisible();
          await alice.screenshot({path: testInfo.outputPath(`outgoing-call-${theme}-${viewport.width}.png`), fullPage: false});
        }
      }
      const outgoingCancel = alice.locator('.call-panel:not(.call-panel-full) .call-actions button');
      await alice.getByRole('button', {name: 'Back to chats'}).focus();
      await alice.keyboard.press('Tab');
      await alice.keyboard.press('Tab');
      await expect(outgoingCancel).toBeFocused();
      expect(await outgoingCancel.evaluate(button => button.matches(':focus-visible'))).toBe(true);
      for (const theme of ['light', 'dark'] as const) {
       await setTheme(bob, theme);
       for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
         await bob.setViewportSize(viewport);
         const incomingPanel = bob.locator('.call-panel:not(.call-panel-full)');
         const incomingCard = incomingPanel.locator('.call-card-incoming');
          await expect(incomingCard).toBeVisible();
          await expect(bob.locator('.message-history')).toBeVisible();
          await expect(bob.getByLabel('Message composer')).toBeVisible();
          const accept = incomingCard.getByRole('button', {name: 'Accept'});
         const decline = incomingCard.getByRole('button', {name: 'Decline'});
         await expect(accept).toBeVisible();
         await expect(decline).toBeVisible();
          const incomingSurface = await measureCallNotificationSurface(bob, '.call-card-incoming');
          const context = `${theme}/${viewport.width}px incoming-call notification: ${JSON.stringify(incomingSurface)}`;
          const expectedSurface = theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(32, 44, 59)';
          expect(incomingSurface.panelSurface, context).toBe(expectedSurface);
          expect(incomingSurface.cardSurface, context).toBe(expectedSurface);
          expect(incomingSurface.actionSurface, context).toBe(expectedSurface);
          expectCallNotificationLayout(incomingSurface, context, viewport);
          expect(incomingSurface.buttons, context).toHaveLength(2);
          if (viewport.width === 390) expectLongCallProfileNameTruncated(incomingSurface, context);
          const nameContrast = await measureRenderedTextContrastAtSurface(incomingCard.locator('app-call-profile .call-presentation-copy strong'));
          const statusContrast = await measureRenderedTextContrastAtSurface(incomingCard.locator('app-call-profile .call-presentation-copy span'));
          const acceptContrast = await measureRenderedTextContrastAtSurface(accept);
          const declineContrast = await measureRenderedTextContrastAtSurface(decline);
         expect(nameContrast.ratio, `${context} caller-name contrast: ${JSON.stringify(nameContrast)}`).toBeGreaterThanOrEqual(4.5);
         expect(statusContrast.ratio, `${context} incoming status contrast: ${JSON.stringify(statusContrast)}`).toBeGreaterThanOrEqual(4.5);
         expect(acceptContrast.ratio, `${context} Accept contrast: ${JSON.stringify(acceptContrast)}`).toBeGreaterThanOrEqual(4.5);
          expect(declineContrast.ratio, `${context} Decline contrast: ${JSON.stringify(declineContrast)}`).toBeGreaterThanOrEqual(4.5);
          await bob.screenshot({path: testInfo.outputPath(`incoming-call-${theme}-${viewport.width}.png`), fullPage: false});
        }
      }
      const incomingAccept = bob.getByRole('button', {name: 'Accept'});
      const incomingDecline = bob.getByRole('button', {name: 'Decline'});
      await bob.getByRole('button', {name: 'Back to chats'}).focus();
      await bob.keyboard.press('Tab');
      await bob.keyboard.press('Tab');
      await expect(incomingAccept).toBeFocused();
      expect(await incomingAccept.evaluate(button => button.matches(':focus-visible'))).toBe(true);
      await bob.keyboard.press('Tab');
      await expect(incomingDecline).toBeFocused();
      expect(await incomingDecline.evaluate(button => button.matches(':focus-visible'))).toBe(true);
      expect(await alice.locator('.call-card-incoming').count()).toBe(0);
     await bob.setViewportSize({width: 2560, height: 1440});
     await setTheme(bob, 'dark');
     await expect(alice.locator('.call-panel:not(.call-panel-full) .call-collapse-button')).not.toBeVisible();
       await expect(bob.locator('.call-panel:not(.call-panel-full) .call-collapse-button')).not.toBeVisible();
       expect(await bob.locator('.call-panel').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBeTruthy();
       await expect(bob.locator('.call-profile')).toContainText('Alice');
       await expect(bob.locator('.person-option.selected')).toContainText('Alice');
       const ringingMessage = 'Message sent while the call is ringing';
       await alice.getByPlaceholder('Write a message…').fill(ringingMessage);
       await alice.getByRole('button', {name: 'Send message'}).click();
       await expect(alice.getByText(ringingMessage, {exact: true})).toBeVisible();
       await expect(bob.getByText(ringingMessage, {exact: true})).toBeVisible();
       await expect(alice.locator('.call-panel:not(.call-panel-full)')).toBeVisible();
       await expect(bob.locator('.call-panel:not(.call-panel-full)')).toBeVisible();
       await bob.getByRole('button', {name: 'Accept'}).click();
        await expect(alice.getByText('Audio call connected.')).toBeVisible({timeout: 10_000});
       await expect(bob.getByText('Audio call connected.')).toBeVisible({timeout: 10_000});
      await expect(bob.locator('.call-panel-full')).toBeVisible();
      await expect(bob.locator('.call-panel-full .direct-call-control-row')).toBeVisible();
      await expect(bob.locator('.call-panel-full .direct-call-end-button')).toBeVisible();
      await bob.screenshot({path: testInfo.outputPath('direct-call-second-incoming-restored-full-surface.png'), fullPage: false});
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
         await expect(alice.getByRole('combobox', {name: 'Screen share quality', exact: true})).toBeVisible();
          const qualitySelect = alice.getByRole('combobox', {name: 'Screen share quality', exact: true});
          const qualitySelectStyle = await qualitySelect.evaluate(element => {
            const style = getComputedStyle(element);
            return {height: style.height, borderRadius: style.borderRadius};
          });
         expect(qualitySelectStyle.height).toBe('48px');
         expect(qualitySelectStyle.borderRadius).toBe('12px');
         await qualitySelect.click();
            await expect(alice.locator('.call-quality-listbox')).toBeVisible();
            await expect(alice.locator('.call-quality-listbox .call-quality-option')).toHaveCount(4);
          await alice.waitForTimeout(250);
            const qualityPanelStyle = await alice.locator('.call-quality-listbox').evaluate(element => {
              const panel = element as HTMLElement;
              const style = getComputedStyle(panel);
              return {classes: panel.className, background: style.backgroundColor, color: style.color};
            });
            await expect(alice.locator('.call-quality-listbox .call-quality-option').filter({hasText: '2K · ultra'})).toBeVisible();
            expect(qualityPanelStyle.classes).toContain('call-select-panel');
            expect(qualityPanelStyle.classes).toContain('call-select-panel-dark');
            expect(qualityPanelStyle).toMatchObject({background: 'rgb(38, 57, 79)'});
            expect(qualityPanelStyle.color).toBe('rgb(241, 245, 249)');
           const darkQualityOption = alice.locator('.call-quality-listbox .call-quality-option').nth(1);
           await expect(darkQualityOption).toHaveCSS('background-color', 'rgb(52, 87, 121)');
           await expect(darkQualityOption).toHaveCSS('color', 'rgb(241, 245, 249)');
           await alice.screenshot({path: testInfo.outputPath('call-select-open-dark.png'), fullPage: false});
           await alice.keyboard.press('Escape');
           await expect(alice.locator('.call-quality-listbox')).toHaveCount(0);
           await alice.setViewportSize({width: 390, height: 844});
           const darkMobileQuality = alice.getByRole('combobox', {name: 'Screen share quality', exact: true});
           await darkMobileQuality.click();
           await expect(alice.locator('.call-quality-listbox')).toBeVisible();
           const darkMobileGeometry = await alice.locator('.call-quality-listbox').evaluate(panel => {
             const rect = panel.getBoundingClientRect();
             const pane = panel.closest<HTMLElement>('.cdk-overlay-pane')?.getBoundingClientRect() ?? rect;
             const actions = document.querySelector<HTMLElement>('.call-panel-full .call-actions')?.getBoundingClientRect();
             return {left: pane.left, right: pane.right, top: pane.top, bottom: pane.bottom, viewportWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight, actions: actions && {left: actions.left, right: actions.right, top: actions.top, bottom: actions.bottom}};
           });
           expect(darkMobileGeometry.left).toBeGreaterThanOrEqual(0);
           expect(darkMobileGeometry.right).toBeLessThanOrEqual(darkMobileGeometry.viewportWidth + 1);
           expect(darkMobileGeometry.top).toBeGreaterThanOrEqual(0);
           expect(darkMobileGeometry.bottom).toBeLessThanOrEqual(darkMobileGeometry.viewportHeight + 1);
           if (!darkMobileGeometry.actions) throw new Error('Mobile dark fixed call action bounds missing with selector open');
           const darkMobileOverlap = darkMobileGeometry.left < darkMobileGeometry.actions.right && darkMobileGeometry.right > darkMobileGeometry.actions.left && darkMobileGeometry.top < darkMobileGeometry.actions.bottom && darkMobileGeometry.bottom > darkMobileGeometry.actions.top;
           expect(darkMobileOverlap, `Mobile dark selector overlaps call actions: ${JSON.stringify(darkMobileGeometry)}`).toBeFalsy();
              await expect(alice.locator('.call-quality-listbox')).toHaveCSS('color', 'rgb(241, 245, 249)');
              await expect(alice.locator('.call-quality-listbox .call-quality-option').nth(1)).toHaveCSS('color', 'rgb(241, 245, 249)');
            await alice.screenshot({path: testInfo.outputPath('call-select-open-dark-mobile-contained.png'), fullPage: false});
            await alice.keyboard.press('Escape');
            await expect(alice.locator('.call-quality-listbox')).toHaveCount(0);
            await expect(darkMobileQuality).toHaveAttribute('aria-expanded', 'false');
            await alice.setViewportSize(desktop.viewport);
            await qualitySelect.focus();
           await alice.keyboard.press('ArrowDown');
           await expect(alice.locator('.call-quality-listbox')).toBeVisible();
           await expect(qualitySelect).toHaveAttribute('aria-expanded', 'true');
           await alice.keyboard.press('ArrowDown');
           await expect(qualitySelect).toHaveAttribute('aria-activedescendant', /call-quality-options-quality-[0-3]/);
             await alice.keyboard.press('Escape');
             await expect(alice.locator('.call-quality-listbox')).toHaveCount(0);
             await expect(qualitySelect).toHaveAttribute('aria-expanded', 'false');
             await qualitySelect.focus();
             await alice.keyboard.press('Enter');
             await expect(alice.locator('.call-quality-listbox')).toBeVisible();
             await expect(alice.locator('.call-quality-listbox [role="option"][aria-selected="true"]')).toContainText('720p');
             const activeQuality = alice.locator('.call-quality-listbox .call-quality-option-active');
             await expect(activeQuality).toHaveAttribute('role', 'option');
             await alice.keyboard.press('ArrowDown');
             await alice.keyboard.press('Enter');
             await expect(alice.locator('.call-quality-listbox')).toHaveCount(0);
             await expect(qualitySelect).toContainText('1080p');
             await expect(qualitySelect).toHaveAttribute('aria-expanded', 'false');
             await qualitySelect.click();
             await alice.locator('.call-quality-listbox [role="option"]').filter({hasText: '720p'}).click();
             await expect(qualitySelect).toContainText('720p');
            await qualitySelect.focus();
            await alice.keyboard.press('Space');
            await expect(alice.locator('.call-quality-listbox')).toBeVisible();
            await expect(qualitySelect).toHaveAttribute('aria-expanded', 'true');
            await alice.keyboard.press('Tab');
            await expect(alice.locator('.call-quality-listbox')).toHaveCount(0);
            await expect(qualitySelect).toHaveAttribute('aria-expanded', 'false');
            await qualitySelect.click();
            await expect(alice.locator('.call-quality-listbox')).toBeVisible();
             await alice.mouse.click(2, 2);
            await expect(alice.locator('.call-quality-listbox')).toHaveCount(0);
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
                const drawTestCapture = (target: CanvasRenderingContext2D): void => {
                  target.fillStyle = '#b84a3a';
                  target.fillRect(0, 0, canvas.width, canvas.height);
                  const markerSize = 120;
                  target.fillStyle = '#19a974';
                  target.fillRect(canvas.width - markerSize, 0, markerSize, markerSize);
                  target.fillStyle = '#2878d0';
                  target.fillRect(0, canvas.height - markerSize, markerSize, markerSize);
                  target.fillStyle = '#e6c229';
                  target.fillRect(canvas.width - markerSize, canvas.height - markerSize, markerSize, markerSize);
                }
                if (context) drawTestCapture(context);
                const stream = canvas.captureStream(5);
               const audioContext = new AudioContext();
               const destination = audioContext.createMediaStreamDestination();
               const audioTrack = destination.stream.getAudioTracks()[0];
               if (audioTrack) stream.addTrack(audioTrack);
               const timer = window.setInterval(() => {
               if (!context) return;
                 drawTestCapture(context);
              }, 200);
              stream.getVideoTracks()[0]?.addEventListener('ended', () => window.clearInterval(timer));
              return stream;
            },
          });
        });
        await alice.getByRole('button', {name: 'Share screen'}).click();
        await expect(alice.locator('.call-screen-stage')).toBeVisible();
        await expect(alice.locator('.call-sharing-indicator')).toContainText('Your screen is being shared with Bob');
        await expect(bob.locator('.call-sharing-indicator')).toContainText(`${aliceDisplayName} is sharing their screen with you`);
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
          const directCardContract = await alice.locator('.call-card').evaluate(card => ({width: getComputedStyle(card).width, radius: getComputedStyle(card).borderTopLeftRadius, padding: getComputedStyle(card).padding, maxWidth: getComputedStyle(document.documentElement).getPropertyValue('--zwei-call-card-max-width').trim(), height: getComputedStyle(document.documentElement).getPropertyValue('--zwei-call-card-height').trim(), sharedPadding: getComputedStyle(document.documentElement).getPropertyValue('--zwei-call-card-padding').trim(), sharedRadius: getComputedStyle(document.documentElement).getPropertyValue('--zwei-call-card-radius').trim()}));
          expect(directCardContract.maxWidth).toBe('720px');
          expect(directCardContract.height).toBe('clamp(620px, 78vh, 760px)');
          expect(directCardContract.sharedPadding).toBe('clamp(22px, 4vw, 42px)');
          expect(directCardContract.sharedRadius).toBe('28px');
      expect(directCardContract.radius).toBe('28px');
          expect(Number.parseFloat(directCardContract.width)).toBe(720);
          await expect(alice.getByRole('button', {name: 'Expand shared screen'})).toBeVisible();
        await alice.getByRole('button', {name: 'Expand shared screen'}).click();
        await expect(alice.getByRole('button', {name: 'Exit fullscreen'})).toBeVisible();
        expect(await alice.locator('.call-screen-stage').evaluate(element => document.fullscreenElement === element)).toBeTruthy();
        const directFullscreenGeometry = await alice.locator('.call-screen-stage').evaluate(stage => {
          const video = stage.querySelector<HTMLVideoElement>('.call-screen-main');
          if (!video || !video.videoWidth || !video.videoHeight) return undefined;
          const stageRect = stage.getBoundingClientRect();
          const videoRect = video.getBoundingClientRect();
          const scale = Math.min(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
          const paintedWidth = video.videoWidth * scale;
          const paintedHeight = video.videoHeight * scale;
          const paintedRect = {
            left: videoRect.left + (videoRect.width - paintedWidth) / 2,
            right: videoRect.left + (videoRect.width + paintedWidth) / 2,
            top: videoRect.top + (videoRect.height - paintedHeight) / 2,
            bottom: videoRect.top + (videoRect.height + paintedHeight) / 2,
          };
          const ancestors = [];
          for (let ancestor: HTMLElement | null = video.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            ancestors.push({className: ancestor.className, overflowX: style.overflowX, overflowY: style.overflowY});
            if (ancestor === stage) break;
          }
          return {
            isFullscreen: document.fullscreenElement === stage,
            stage: {left: stageRect.left, right: stageRect.right, top: stageRect.top, bottom: stageRect.bottom, width: stageRect.width, height: stageRect.height, scrollWidth: stage.scrollWidth, clientWidth: stage.clientWidth, scrollHeight: stage.scrollHeight, clientHeight: stage.clientHeight},
            video: {left: videoRect.left, right: videoRect.right, top: videoRect.top, bottom: videoRect.bottom, width: videoRect.width, height: videoRect.height, videoWidth: video.videoWidth, videoHeight: video.videoHeight, objectFit: getComputedStyle(video).objectFit, objectPosition: getComputedStyle(video).objectPosition},
            paintedRect,
            ancestors,
            document: {scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight},
          };
        });
        console.info(`DIRECT_FULLSCREEN_SCREEN_GEOMETRY ${JSON.stringify(directFullscreenGeometry)}`);
        if (!directFullscreenGeometry) throw new Error('Fullscreen shared video geometry was unavailable');
        expect(directFullscreenGeometry.isFullscreen).toBe(true);
        expect(directFullscreenGeometry.video.objectFit).toBe('contain');
        expect(directFullscreenGeometry.paintedRect.left).toBeGreaterThanOrEqual(directFullscreenGeometry.stage.left - 1);
        expect(directFullscreenGeometry.paintedRect.right).toBeLessThanOrEqual(directFullscreenGeometry.stage.right + 1);
        expect(directFullscreenGeometry.paintedRect.top).toBeGreaterThanOrEqual(directFullscreenGeometry.stage.top - 1);
        expect(directFullscreenGeometry.paintedRect.bottom).toBeLessThanOrEqual(directFullscreenGeometry.stage.bottom + 1);
        expect(directFullscreenGeometry.stage.scrollWidth).toBeLessThanOrEqual(directFullscreenGeometry.stage.clientWidth + 1);
        expect(directFullscreenGeometry.stage.scrollHeight).toBeLessThanOrEqual(directFullscreenGeometry.stage.clientHeight + 1);
        await alice.screenshot({path: testInfo.outputPath('call-screen-share-fullscreen-dark.png'), fullPage: false});
        await alice.getByRole('button', {name: 'Exit fullscreen'}).click();
        await bob.getByRole('button', {name: 'Expand shared screen'}).click();
        await expect(bob.getByRole('button', {name: 'Exit fullscreen'})).toBeVisible();
        const remoteFullscreenGeometry = await bob.locator('.call-screen-stage').evaluate(stage => {
          const video = stage.querySelector<HTMLVideoElement>('.call-screen-remote');
          if (!video || !video.videoWidth || !video.videoHeight) return undefined;
          const stageRect = stage.getBoundingClientRect();
          const videoRect = video.getBoundingClientRect();
          const style = getComputedStyle(video);
          const scale = Math.min(videoRect.width / video.videoWidth, videoRect.height / video.videoHeight);
          const paintedWidth = video.videoWidth * scale;
          const paintedHeight = video.videoHeight * scale;
          return {
            isFullscreen: document.fullscreenElement === stage,
            video: {objectFit: style.objectFit, videoWidth: video.videoWidth, videoHeight: video.videoHeight},
            stage: {left: stageRect.left, right: stageRect.right, top: stageRect.top, bottom: stageRect.bottom, width: stageRect.width, height: stageRect.height},
            paintedRect: {left: videoRect.left + (videoRect.width - paintedWidth) / 2, right: videoRect.left + (videoRect.width + paintedWidth) / 2, top: videoRect.top + (videoRect.height - paintedHeight) / 2, bottom: videoRect.top + (videoRect.height + paintedHeight) / 2},
          };
        });
        console.info(`REMOTE_FULLSCREEN_SCREEN_GEOMETRY ${JSON.stringify(remoteFullscreenGeometry)}`);
        if (!remoteFullscreenGeometry) throw new Error('Fullscreen remote screen geometry was unavailable');
        expect(remoteFullscreenGeometry.isFullscreen).toBe(true);
        expect(remoteFullscreenGeometry.video.objectFit).toBe('contain');
        expect(remoteFullscreenGeometry.paintedRect.left).toBeGreaterThanOrEqual(remoteFullscreenGeometry.stage.left - 1);
        expect(remoteFullscreenGeometry.paintedRect.right).toBeLessThanOrEqual(remoteFullscreenGeometry.stage.right + 1);
        expect(remoteFullscreenGeometry.paintedRect.top).toBeGreaterThanOrEqual(remoteFullscreenGeometry.stage.top - 1);
        expect(remoteFullscreenGeometry.paintedRect.bottom).toBeLessThanOrEqual(remoteFullscreenGeometry.stage.bottom + 1);
        await bob.screenshot({path: testInfo.outputPath('call-screen-share-remote-fullscreen-dark.png'), fullPage: false});
        await bob.getByRole('button', {name: 'Exit fullscreen'}).click();
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
           alice.getByRole('combobox', {name: 'Screen share quality', exact: true}),
           alice.getByRole('button', {name: 'Stop sharing'}),
         ];
        const desktopControlBoxes = await Promise.all(desktopCallControls.map(control => control.boundingBox()));
        const desktopControlHeights = desktopControlBoxes.filter((box): box is NonNullable<typeof box> => Boolean(box)).map(box => box.height);
        expect(desktopControlHeights.length).toBe(desktopCallControls.length);
         expect(Math.max(...desktopControlHeights) - Math.min(...desktopControlHeights)).toBeLessThanOrEqual(2);
          const desktopContent = alice.locator('.call-panel-full .call-card-content');
        const desktopContentMetrics = await desktopContent.evaluate(element => {
          const content = element as HTMLElement;
          const rect = content.getBoundingClientRect();
          const measure = (node: HTMLElement | null) => {
            if (!node) return undefined;
            const bounds = node.getBoundingClientRect();
            return {left: bounds.left, right: bounds.right, width: bounds.width, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth};
          };
          const measureSelect = (label: Element) => {
            const select = label.querySelector<HTMLElement>('.call-select');
            if (!select) return {label: measure(label as HTMLElement)};
            const arrow = select.querySelector<HTMLElement>('.mat-mdc-select-arrow');
            return {label: measure(label as HTMLElement), select: measure(select), arrow: measure(arrow)};
          };
          return {
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            scrollWidth: content.scrollWidth,
            clientWidth: content.clientWidth,
            scrollHeight: content.scrollHeight,
            clientHeight: content.clientHeight,
            contentRight: rect.right,
            children: Array.from(content.children).map(child => ({name: child.tagName.toLowerCase(), ...measure(child as HTMLElement)})),
            stage: measure(content.querySelector<HTMLElement>('.call-screen-stage')),
            devices: measure(content.querySelector<HTMLElement>('.call-devices')),
            tools: measure(content.querySelector<HTMLElement>('.call-screen-tools')),
            labels: Array.from(content.querySelectorAll<HTMLElement>('.call-devices label')).map(measureSelect),
         };
        });
        console.info(`DIRECT_CALL_CONTENT_GEOMETRY ${JSON.stringify(desktopContentMetrics)}`);
        expect(desktopContentMetrics.scrollWidth, `${desktopContentMetrics.viewport} direct call content horizontal overflow: ${JSON.stringify(desktopContentMetrics)}`).toBeLessThanOrEqual(desktopContentMetrics.clientWidth + 1);
        expect(desktopContentMetrics.devices?.scrollWidth, `${desktopContentMetrics.viewport} device-control horizontal overflow: ${JSON.stringify(desktopContentMetrics.devices)}`).toBeLessThanOrEqual((desktopContentMetrics.devices?.clientWidth ?? 0) + 1);
        for (const label of desktopContentMetrics.labels) {
          if (label.select) expect(label.select.scrollWidth, `${desktopContentMetrics.viewport} select overflow: ${JSON.stringify(label.select)}`).toBeLessThanOrEqual(label.select.clientWidth + 1);
          if (label.arrow) expect(label.arrow.scrollWidth, `${desktopContentMetrics.viewport} select-arrow overflow: ${JSON.stringify(label.arrow)}`).toBeLessThanOrEqual(label.arrow.clientWidth + 1);
        }
            const desktopAudioOption = alice.getByRole('checkbox', {name: 'Share audio'});
            await expect(desktopAudioOption).toBeVisible();
            const desktopAudioBox = await alice.locator('.share-audio-toggle').boundingBox();
            const desktopContentBox = await desktopContent.boundingBox();
            const desktopActionsBox = await alice.locator('.call-panel-full .call-actions').boundingBox();
            if (!desktopAudioBox || !desktopContentBox || !desktopActionsBox) throw new Error('Desktop share-audio option or call actions were not visible');
            const desktopQualityBox = await alice.locator('.call-quality-trigger').boundingBox();
            if (!desktopQualityBox) throw new Error('Desktop quality control was not visible');
            expect(Math.abs(desktopAudioBox.y - desktopQualityBox.y)).toBeLessThanOrEqual(2);
            await expect(alice.locator('.share-audio-label')).toHaveText('Share audio');
            expect(desktopAudioBox.y).toBeGreaterThanOrEqual(desktopContentBox.y - 1);
            expect(desktopAudioBox.y + desktopAudioBox.height).toBeLessThanOrEqual(desktopContentBox.y + desktopContentBox.height + 16);
            expect(desktopAudioBox.y + desktopAudioBox.height).toBeLessThanOrEqual(desktopActionsBox.y + 16);
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
         await alice.setViewportSize({width: 390, height: 844});
         await qualitySelect.click();
         await expect(alice.locator('.call-quality-listbox')).toBeVisible();
         await expect(alice.locator('.call-quality-listbox')).toHaveClass(/call-select-panel-light/);
         await expect(alice.locator('.call-quality-listbox')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
         const lightQualityOption = alice.locator('.call-quality-listbox .call-quality-option').nth(1);
        await expect(lightQualityOption).toHaveCSS('background-color', 'rgb(220, 234, 250)');
        await expect(lightQualityOption).toHaveCSS('color', 'rgb(23, 32, 51)');
         const openLightPanelGeometry = await alice.locator('.call-quality-listbox').evaluate(panel => {
          const rect = panel.getBoundingClientRect();
          const actions = document.querySelector<HTMLElement>('.call-panel-full .call-actions')?.getBoundingClientRect();
          const content = document.querySelector<HTMLElement>('.call-panel-full .call-card-content');
           const trigger = document.querySelector<HTMLElement>('.call-panel-full .call-card-content .call-select[aria-label="Screen share quality"]')?.getBoundingClientRect();
           const panelElement = panel as HTMLElement;
           const pane = panel.closest<HTMLElement>('.cdk-overlay-pane');
           const bounds = pane?.getBoundingClientRect() ?? rect;
           return {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, scrollWidth: panelElement.scrollWidth, clientWidth: panelElement.clientWidth, trigger: trigger && {top: trigger.top, bottom: trigger.bottom}, content: content && {top: content.getBoundingClientRect().top, bottom: content.getBoundingClientRect().bottom, scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, paddingTop: getComputedStyle(content).paddingTop}, actions: actions && {left: actions.left, right: actions.right, top: actions.top, bottom: actions.bottom}, viewportWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight};
        });
        console.info(`OPEN_LIGHT_QUALITY_GEOMETRY ${JSON.stringify(openLightPanelGeometry)}`);
        expect(openLightPanelGeometry.left).toBeGreaterThanOrEqual(0);
        expect(openLightPanelGeometry.right).toBeLessThanOrEqual(openLightPanelGeometry.viewportWidth + 1);
        expect(openLightPanelGeometry.top).toBeGreaterThanOrEqual(0);
        expect(openLightPanelGeometry.bottom).toBeLessThanOrEqual(openLightPanelGeometry.viewportHeight + 1);
        expect(openLightPanelGeometry.scrollWidth).toBeLessThanOrEqual(openLightPanelGeometry.clientWidth + 1);
        if (!openLightPanelGeometry.actions) throw new Error('Mobile fixed call action bounds missing with selector open');
        const menuOverlapsAction = openLightPanelGeometry.left < openLightPanelGeometry.actions.right && openLightPanelGeometry.right > openLightPanelGeometry.actions.left && openLightPanelGeometry.top < openLightPanelGeometry.actions.bottom && openLightPanelGeometry.bottom > openLightPanelGeometry.actions.top;
        expect(menuOverlapsAction, `Mobile light selector overlaps call actions: ${JSON.stringify(openLightPanelGeometry)}`).toBeFalsy();
        await expect(alice.locator('.call-quality-listbox')).toHaveCSS('color', 'rgb(23, 32, 51)');
        await expect(alice.locator('.call-quality-listbox .call-quality-option').nth(1)).toHaveCSS('color', 'rgb(23, 32, 51)');
        await alice.screenshot({path: testInfo.outputPath('call-select-open-light-mobile-contained.png'), fullPage: false});
        await alice.screenshot({path: testInfo.outputPath('call-select-open-light.png'), fullPage: false});
        await lightQualityOption.click();
        await expect(alice.locator('.call-quality-listbox')).toHaveCount(0);
        await expect(qualitySelect).toHaveAttribute('aria-expanded', 'false');
        await expect(alice.getByRole('button', {name: 'End call'})).toBeVisible();
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
         expect(mobileCollapseBox.x).toBeGreaterThan(mobileCardBox.x + mobileCardBox.width - mobileCollapseBox.width - 24);
         expect(mobileCollapseBox.x + mobileCollapseBox.width).toBeLessThanOrEqual(mobileCardBox.x + mobileCardBox.width + 1);
         expect(mobileCollapseBox.y).toBeGreaterThanOrEqual(mobileProfileBox.y - 48);
         expect(mobileCollapseBox.y + mobileCollapseBox.height).toBeLessThanOrEqual(mobileProfileBox.y + 48);
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
            alice.getByRole('combobox', {name: 'Screen share quality', exact: true}),
          alice.getByRole('button', {name: 'Stop sharing'}),
        ];
       const mobileControlBoxes = await Promise.all(mobileCallControls.map(control => control.boundingBox()));
        const mobileControlHeights = mobileControlBoxes.filter((box): box is NonNullable<typeof box> => Boolean(box)).map(box => box.height);
        expect(mobileControlHeights.length).toBe(mobileCallControls.length);
          expect(Math.max(...mobileControlHeights) - Math.min(...mobileControlHeights)).toBeLessThanOrEqual(2);
          const mobileStopShareBox = await alice.getByRole('button', {name: 'Stop sharing'}).boundingBox();
          if (!mobileStopShareBox) throw new Error('Mobile stop-sharing bounds were not available');
           await expect(screenAudioCheckbox).toBeVisible();
           const mobileAudioCheckboxBox = await alice.locator('.share-audio-toggle').boundingBox();
           if (!mobileAudioCheckboxBox) throw new Error('Mobile system-audio checkbox bounds were not available');
           const mobileQualityBox = await alice.locator('.call-quality-trigger').boundingBox();
           if (!mobileQualityBox) throw new Error('Mobile screen-quality bounds were not available');
           expect(Math.abs(mobileAudioCheckboxBox.y - mobileQualityBox.y)).toBeLessThanOrEqual(4);
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
            const mobileFinalControlBoxes = await Promise.all(mobileCallControls.slice(0, 3).map(control => control.boundingBox()));
            const mobileShareActionBox = await alice.getByRole('button', {name: 'Stop sharing'}).boundingBox();
           const mobileMuteActionBox = await alice.getByRole('button', {name: 'Mute microphone'}).boundingBox();
           if (!mobileShareActionBox || !mobileMuteActionBox || !mobileActionBox) throw new Error('Mobile sticky call actions were not visible');
           expect(mobileMuteActionBox.y).toBeGreaterThanOrEqual(mobileActionBox.y - 1);
           expect(mobileShareActionBox.y).toBeGreaterThanOrEqual(mobileActionBox.y - 1);
           expect(mobileMuteActionBox.y + mobileMuteActionBox.height).toBeLessThanOrEqual(mobileActionBox.y + mobileActionBox.height + 1);
            expect(mobileShareActionBox.y + mobileShareActionBox.height).toBeLessThanOrEqual(mobileActionBox.y + mobileActionBox.height + 1);
            expect(mobileShareActionBox.y + mobileShareActionBox.height).toBeLessThanOrEqual(844);
            expect(mobileFinalControlBoxes.length).toBe(3);
            for (const [index, controlBox] of mobileFinalControlBoxes.entries()) {
              if (!controlBox) throw new Error(`Mobile device control ${index} bounds missing at end of call-content scroll`);
              expect(controlBox.y).toBeGreaterThanOrEqual(mobileStickyGeometry.contentTop - 1);
              expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(mobileActionBox.y - 1);
            }
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
  await expect(alice.getByRole('heading', {name: 'Bob'})).toBeVisible();
  const startOfflineCall = alice.getByRole('button', {name: 'Start audio call'});
  await expect(startOfflineCall).toBeEnabled();
  await startOfflineCall.click();
  const offlineCallNotice = alice.getByText('Call unavailable: recipient is offline', {exact: true});
  // The notice auto-dismisses at 5 seconds; observe it before its expiry rather
  // than using an assertion timeout equal to the notice's lifetime.
  await expect(offlineCallNotice).toHaveCount(1, {timeout: 4_000});
  await expect(offlineCallNotice).toBeVisible({timeout: 4_000});
  await alice.screenshot({path: testInfo.outputPath('direct-call-recipient-offline-notice.png'), fullPage: false});
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
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(alice, theme);
    for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
      await alice.setViewportSize(viewport);
      const sentMessage = alice.getByText(messages[0]).locator('xpath=ancestor::article');
      const senderContrast = await measureRenderedTextContrast(sentMessage.locator('.message-sender'));
      const timeContrast = await measureRenderedTextContrast(sentMessage.locator('time'));
      expect(senderContrast.ratio, `${theme}/${viewport.width} own-message sender contrast: ${JSON.stringify(senderContrast)}`).toBeGreaterThanOrEqual(4.5);
      expect(timeContrast.ratio, `${theme}/${viewport.width} own-message timestamp contrast: ${JSON.stringify(timeContrast)}`).toBeGreaterThanOrEqual(4.5);
      const readMarker = sentMessage.locator('.message-read');
      if (await readMarker.count()) {
        const readContrast = await measureRenderedTextContrast(readMarker);
        expect(readContrast.ratio, `${theme}/${viewport.width} own-message peer-read marker contrast: ${JSON.stringify(readContrast)}`).toBeGreaterThanOrEqual(4.5);
      }
      await alice.screenshot({path: testInfo.outputPath(`direct-own-message-metadata-${theme}-${viewport.width}.png`), fullPage: false});
    }
  }
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

test('Home people search clears results, distinguishes empty and failed states, and ignores superseded responses', async ({browser}, testInfo) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('home-search');
  const context = await browser.newContext({viewport: {width: 1440, height: 900}});
  const page = await context.newPage();
  const validQuery = `valid-${Date.now()}`;
  const pluralQuery = `plural-${Date.now()}`;
  const emptyQuery = `empty-${Date.now()}`;
  const malformedQuery = `malformed-${Date.now()}`;
  const errorQuery = `error-${Date.now()}`;
  const staleQuery = `stale-${Date.now()}`;
  const currentQuery = `current-${Date.now()}`;
  const result = {id: 'search-result-user', display_name: 'Search Result Person', email: 'search-result@example.test'};
  let releaseStaleResponse = (): void => {};
  let staleRequestStarted = (): void => {};
  const staleResponseGate = new Promise<void>(resolve => { releaseStaleResponse = resolve; });
  const staleRequest = new Promise<void>(resolve => { staleRequestStarted = resolve; });

  try {
    await register(page, email, 'Home Search User');
    await waitForLiveConnection(page);
    await page.route('**/api/chat/users/search?*', async route => {
      const query = new URL(route.request().url()).searchParams.get('q');
      if (query === staleQuery) {
        staleRequestStarted();
        await staleResponseGate;
        await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([{...result, id: 'stale-user', display_name: 'Stale Search Person'}])});
        return;
      }
      if (query === pluralQuery) {
        await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([result, {...result, id: 'second-search-result-user', display_name: 'Another Search Person', email: 'another-search-result@example.test'}])});
      } else if (query === validQuery || query === currentQuery) {
        await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([result])});
      } else if (query === emptyQuery) {
        await route.fulfill({status: 200, contentType: 'application/json', body: '[]'});
      } else if (query === malformedQuery) {
        await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify([{id: 42, display_name: 'Malformed', email: 'malformed@example.test'}])});
      } else if (query === errorQuery) {
        await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'deterministic search failure'})});
      } else {
        await route.fallback();
      }
    });

    const search = page.getByPlaceholder('Name or email');
    const searchStatus = page.locator('.conversation-rail > .group-search-status[role="status"]');
    const resultOptions = page.locator('.search-result');
    await search.fill(validQuery);
    await expect(resultOptions).toHaveCount(1);
    await expect(resultOptions.first()).toHaveAttribute('aria-label', 'Start a conversation with Search Result Person');
    await expect(searchStatus).toHaveRole('status');
    await expect(searchStatus).toHaveText('1 person found.');

    await search.fill(pluralQuery);
    await expect(resultOptions).toHaveCount(2);
    await expect(searchStatus).toHaveText('2 people found.');

    await search.fill(emptyQuery);
    await expect(resultOptions).toHaveCount(0);
    await expect(searchStatus).toHaveRole('status');
    await expect(searchStatus).toHaveText('No people found. Try another name or email.');
    await expect(page.locator('.conversation-rail [role="alert"]')).toHaveCount(0);

    await search.fill(malformedQuery);
    await expect(resultOptions).toHaveCount(0);
    const malformedAlert = page.locator('.conversation-rail .group-search-status[role="alert"]');
    await expect(malformedAlert).toHaveText('Could not search for people. Try again.');
    await expect(searchStatus).toHaveCount(0);

    await search.fill(errorQuery);
    await expect(resultOptions).toHaveCount(0);
    await expect(malformedAlert).toHaveText('Could not search for people. Try again.');
    await expect(page.locator('.conversation-rail [role="status"]')).toHaveCount(0);

    // The stale request is deliberately held while a newer query completes. Releasing it
    // afterward proves that an obsolete completion cannot overwrite the current options.
    await search.fill(staleQuery);
    await staleRequest;
    await expect(resultOptions).toHaveCount(0);
    await search.fill(currentQuery);
    await expect(resultOptions).toHaveCount(1);
    await expect(resultOptions.first()).toContainText('Search Result Person');
    releaseStaleResponse();
    await expect(resultOptions).toHaveCount(1);
    await expect(resultOptions.first()).toContainText('Search Result Person');
    await expect(resultOptions).not.toContainText('Stale Search Person');

    // Capture the two distinct terminal states across the representative desktop/mobile
    // and light/dark matrix, using the same account and deterministic route responses.
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
        await page.setViewportSize(viewport);
        await search.fill(emptyQuery);
        await expect(resultOptions).toHaveCount(0);
        await expect(searchStatus).toHaveRole('status');
        await expect(searchStatus).toHaveText('No people found. Try another name or email.');
        await page.screenshot({path: testInfo.outputPath(`home-people-search-empty-${theme}-${viewport.width}.png`), fullPage: false});

        await search.fill(errorQuery);
        await expect(resultOptions).toHaveCount(0);
        await expect(malformedAlert).toHaveText('Could not search for people. Try again.');
        await page.screenshot({path: testInfo.outputPath(`home-people-search-error-${theme}-${viewport.width}.png`), fullPage: false});
      }
    }
  } finally {
    releaseStaleResponse();
    await context.close();
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

test('measures visible Home rail and composer text contrast in light and dark themes', async ({browser}, testInfo) => {
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  const page = await context.newPage();

  try {
    await register(page, uniqueEmail('mobile-text-contrast'), 'Contrast');
    await waitForLiveConnection(page);
    const allChats = page.locator('.rail-label > span').first();
    const searchInput = page.locator('.search-field input');
    const searchLabel = page.locator('.search-field .mdc-floating-label');
    const composer = page.locator('.composer textarea');
    await expect(allChats).toHaveText('All chats');
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveAttribute('placeholder', 'Choose a chat to start messaging');

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await expect(searchLabel).toHaveText('Search people');
      await expect(searchLabel).toBeVisible();
      const unfocusedLabel = await measureRenderedTextContrastAtSurface(searchLabel);
      expect(unfocusedLabel.ratio, `${theme} unfocused search label contrast: ${JSON.stringify(unfocusedLabel)}`).toBeGreaterThanOrEqual(4.5);
      await searchInput.focus();
      await expect(searchInput).toBeFocused();
      await expect(page.locator('.search-field .mdc-text-field--focused')).toBeVisible();
      await expect.poll(async () => (await measureRenderedTextContrastAtSurface(searchInput, '::placeholder')).opacity).toBeGreaterThanOrEqual(0.99);
      const metrics = {
        allChats: await measureRenderedTextContrastAtSurface(allChats),
        searchPlaceholder: await measureRenderedTextContrastAtSurface(searchInput, '::placeholder'),
      };
      console.log(`HOME_MOBILE_TEXT_CONTRAST ${JSON.stringify({theme, viewport: {width: 390, height: 844}, metrics})}`);
      expect(metrics.allChats.ratio, `${theme} All chats contrast: ${JSON.stringify(metrics.allChats)}`).toBeGreaterThanOrEqual(4.5);
      expect(metrics.searchPlaceholder.opacity, `${theme} focused search placeholder opacity`).toBeGreaterThan(0);
      expect(metrics.searchPlaceholder.ratio, `${theme} focused Name or email contrast: ${JSON.stringify(metrics.searchPlaceholder)}`).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({path: testInfo.outputPath(`home-mobile-empty-text-contrast-${theme}-390.png`), fullPage: false});
      await searchInput.blur();
      await expect(searchInput).not.toBeFocused();

      // At mobile width the unselected chat panel is hidden; measure its real text at desktop width.
      await page.setViewportSize({width: 1440, height: 900});
      await expect(composer).toBeVisible();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const idleSearch = await searchInput.evaluate(input => {
        const field = input.closest<HTMLElement>('.mat-mdc-form-field');
        const label = field?.querySelector<HTMLElement>('.mdc-floating-label');
        const labelRect = label?.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        return {focused: document.activeElement === input, placeholderOpacity: getComputedStyle(input, '::placeholder').opacity, labelFloatClass: !!label?.classList.contains('mdc-floating-label--float-above'), label: labelRect ? {left: labelRect.left, right: labelRect.right, top: labelRect.top, bottom: labelRect.bottom} : undefined, input: {left: inputRect.left, right: inputRect.right, top: inputRect.top, bottom: inputRect.bottom}};
      });
      console.log(`HOME_DESKTOP_IDLE_SEARCH ${JSON.stringify({theme, viewport: {width: 1440, height: 900}, idleSearch})}`);
      expect(idleSearch.focused).toBe(false);
      expect(Number.parseFloat(idleSearch.placeholderOpacity)).toBeLessThanOrEqual(0.01);
      expect(idleSearch.label).toBeDefined();
      const composerPlaceholder = await measureRenderedTextContrastAtSurface(composer, '::placeholder');
      expect(composerPlaceholder.opacity, `${theme} disabled composer placeholder opacity`).toBeGreaterThan(0);
      expect(composerPlaceholder.ratio, `${theme} empty composer placeholder contrast: ${JSON.stringify(composerPlaceholder)}`).toBeGreaterThanOrEqual(4.5);
      await page.screenshot({path: testInfo.outputPath(`home-desktop-empty-text-contrast-${theme}-1440.png`), fullPage: false});
      await page.setViewportSize({width: 390, height: 844});
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

test('a departed member quarantines private group UI after a newer revision and retries a failed projection', async ({browser}, testInfo) => {
  test.setTimeout(120_000);
  // Acceptance matrix: failed quarantine -> authorized 404 recovery; light/dark x 1440x900/390x844.
  // At every error checkpoint private history, selection, details and actions stay absent; retry is reachable.
  const ownerEmail = uniqueEmail('departure-owner');
  const memberEmail = uniqueEmail('departure-member');
  const ownerContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const memberContext = await browser.newContext({viewport: {width: 1440, height: 900}});
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();
  let groupID = '';
  let releaseLeave = (): void => {};
  let releaseProjection = (): void => {};
  let failProjection = false;
  const leaveGate = new Promise<void>(resolve => { releaseLeave = resolve; });
  const projectionGate = new Promise<void>(resolve => { releaseProjection = resolve; });
  let signalProjection = (): void => {};
  const projectionPending = new Promise<void>(resolve => { signalProjection = resolve; });
  let leaveStarted = (): void => {};
  const leavePending = new Promise<void>(resolve => { leaveStarted = resolve; });
  try {
    await Promise.all([installDeterministicGroupMedia(owner, '#b84a3a'), installDeterministicGroupMedia(member, '#2563eb')]);
    // Delay only the removal notification: the real server and all other frames remain live.
    // A removal frame may precede the HTTP response, so the test must not depend on that ordering.
    await member.routeWebSocket('**/ws/v2?ticket=*', socket => {
      const server = socket.connectToServer();
      server.onMessage(message => {
        if (typeof message === 'string') {
          let event: unknown;
          try { event = JSON.parse(message); } catch { /* Forward non-JSON frames. */ }
          if (isRecord(event) && event.type === 'group.membership.changed' && isRecord(event.payload)
            && event.payload.conversation_id === groupID && event.payload.deleted === true) return;
        }
        socket.send(message);
      });
    });
    await register(owner, ownerEmail, 'Owner');
    await register(member, memberEmail, 'Member');
    await Promise.all([waitForLiveConnection(owner), waitForLiveConnection(member)]);
    const ownerToken = await authenticatedToken(ownerContext, ownerEmail, 'departure-owner');
    const memberID = await userID(ownerContext, ownerToken, memberEmail);
    await owner.getByRole('button', {name: 'Create group'}).click();
    await owner.getByLabel('Group name').fill('Departure quarantine group');
    const createResponse = owner.waitForResponse(response => response.url().endsWith('/api/chat/groups') && response.request().method() === 'POST');
    await owner.locator('.group-create-card').getByRole('button', {name: 'Create group'}).click();
    const created = await createResponse;
    expect(created.status()).toBe(201);
    groupID = (await created.json() as {id: string}).id;
    await owner.getByLabel('Find a person').fill(memberEmail);
    await owner.getByRole('option', {name: new RegExp(memberEmail)}).click();
    await owner.getByRole('button', {name: 'Add member'}).click();
    const memberRow = owner.locator('.group-members li').filter({has: owner.locator('strong').getByText('Member', {exact: true})});
    await expect(memberRow).toBeVisible();
    await member.reload();
    await waitForLiveConnection(member);
    await member.locator('.person-option').filter({hasText: 'Departure quarantine group'}).click();
    await owner.getByPlaceholder('Write a message…').fill('Private departure history');
    await owner.getByRole('button', {name: 'Send message'}).click();
    await expect(member.getByRole('region', {name: 'Message history'}).getByText('Private departure history')).toBeVisible();
    await member.getByPlaceholder('Write a message…').fill('Private departure reply');
    await member.getByRole('button', {name: 'Send message'}).click();
    await expect(member.getByText('Private departure reply')).toBeVisible();

    const memberURL = `${chatBase}/api/chat/groups/${groupID}/members/${memberID}`;
    const authHeaders = {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`};
    const promoted = await ownerContext.request.patch(memberURL, {headers: authHeaders, data: {role: 'admin'}});
    expect(promoted.status()).toBe(200);
    await expect(member.getByRole('button', {name: 'Manage group'})).toBeVisible({timeout: 10_000});

    await owner.getByRole('button', {name: 'Join or start group audio call'}).click();
    await member.getByRole('button', {name: 'Join call'}).click();
    await Promise.all([owner, member].map(async page => {
      await expect(page.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000});
      await expect(page.getByRole('button', {name: 'Leave call'})).toBeVisible();
      await expect(page.getByRole('button', {name: 'End group call for everyone'})).toBeVisible();
    }));
    await owner.waitForTimeout(2_000);
    await owner.getByRole('button', {name: 'End group call for everyone'}).click({force: true});
    await expect(owner.locator('.group-call-terminal')).toContainText('Group call ended.');
    await expect(member.locator('.group-call-terminal')).toContainText('Group call ended.');
    const endedActiveCallTracks = await Promise.all([owner, member].map(page => page.evaluate(() => {
      const tracks = (window as Window & {__groupLocalTracks?: MediaStreamTrack[]}).__groupLocalTracks ?? [];
      return tracks.length > 0 && tracks.every(track => track.readyState === 'ended');
    })));
    expect(endedActiveCallTracks).toEqual([true, true]);

    await owner.getByRole('button', {name: 'Join or start group audio call'}).click();
    await member.getByRole('button', {name: 'Join call'}).click();
    await Promise.all([owner, member].map(page => expect(page.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000})));

    // Demote while the member's own leave HTTP is held.
    await member.getByRole('button', {name: 'Manage group'}).click();
    await expect(member.getByRole('button', {name: 'Leave group'})).toBeVisible();
    await member.route(`**/api/chat/groups/${groupID}/leave`, async route => {
      leaveStarted();
      await leaveGate;
      await route.continue();
    });
    await member.route(`**/api/chat/groups/${groupID}`, async route => {
        if (route.request().method() === 'GET' && failProjection) {
          signalProjection();
          await projectionGate;
          await route.fulfill({status: 500, contentType: 'application/json', body: '{"error":"temporary projection failure"}'});
      } else await route.continue();
    });
    const leaveResponse = member.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}/leave`) && response.request().method() === 'POST');
    member.once('dialog', async dialog => {
      expect(dialog.message()).toBe('Leave this group?');
      await dialog.accept();
    });
    await member.getByRole('button', {name: 'Leave group'}).click();
    await leavePending;
    const revisionResponse = member.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}`) && response.request().method() === 'GET' && response.status() === 200);
    const demoted = await ownerContext.request.patch(memberURL, {headers: authHeaders, data: {role: 'member'}});
    expect(demoted.status()).toBe(200);
    const advanced = await revisionResponse;
    const projection = await advanced.json() as {membership_revision: number};
    expect(projection.membership_revision).toBeGreaterThan((await promoted.json() as {membership_revision: number}).membership_revision);
    await expect(member.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 10_000});
    await expect(member.locator('.group-call-panel')).toHaveCount(0);
    await expect(owner.locator('.group-call-panel')).toHaveCount(0);
    await expect(member.locator('audio[groupRemoteAudio]')).toHaveCount(0);
    await expect.poll(() => member.evaluate(() => {
      const tracks = (window as Window & {__groupLocalTracks?: MediaStreamTrack[]}).__groupLocalTracks ?? [];
      return tracks.length > 0 && tracks.every(track => track.readyState === 'ended');
    }), {timeout: 10_000}).toBeTruthy();
    await expect.poll(() => owner.evaluate(() => {
      const tracks = (window as Window & {__groupLocalTracks?: MediaStreamTrack[]}).__groupLocalTracks ?? [];
      return tracks.length > 0 && tracks.every(track => track.readyState === 'ended');
    }), {timeout: 10_000}).toBeTruthy();
    await member.screenshot({path: testInfo.outputPath('departure-quarantine-active-call-terminated-light-1440.png'), fullPage: false});
    await expect(member.getByRole('button', {name: 'Manage group'})).toHaveCount(0);
    await expect(member.getByRole('heading', {name: 'Departure quarantine group'})).toHaveCount(0);
    await expect(member.locator('.person-option').filter({hasText: 'Departure quarantine group'})).toHaveCount(0);
    await expect(member.locator('.message-history')).toHaveCount(0);
    await expect(member.getByText('Private departure history')).toHaveCount(0);
    await expect(member.getByText('Private departure reply')).toHaveCount(0);
    await expect(member.locator('.group-manager, .group-members, .member-actions')).toHaveCount(0);
    await expect(member.getByRole('button', {name: 'Join or start group audio call'})).toHaveCount(0);
    await expect(member.locator('.group-call-panel')).toHaveCount(0);
    await expect(member.locator('.group-call-terminal')).toContainText('Group call ended.');
    await expect(owner.locator('.group-call-panel')).toHaveCount(0);
    await expect(member.locator('.composer textarea')).toBeDisabled();
    await expect.poll(() => member.evaluate(() => {
      const tracks = (window as Window & {__groupLocalTracks?: MediaStreamTrack[]}).__groupLocalTracks ?? [];
      return tracks.length > 0 && tracks.every(track => track.readyState === 'ended');
    }), {timeout: 10_000}).toBeTruthy();
    await expect.poll(() => owner.evaluate(() => {
      const tracks = (window as Window & {__groupLocalTracks?: MediaStreamTrack[]}).__groupLocalTracks ?? [];
      return tracks.length > 0 && tracks.every(track => track.readyState === 'ended');
    }), {timeout: 10_000}).toBeTruthy();
    await expect(member.getByRole('status').filter({hasText: 'Checking group access'})).toBeVisible();
    failProjection = true;
    releaseLeave();
    expect((await leaveResponse).status()).toBe(204);
    await projectionPending;
    await expect(member.getByRole('status').filter({hasText: 'Checking group access'})).toBeVisible();
    await expect(member.getByText('Private departure history')).toHaveCount(0);
    await expect(member.locator('.composer textarea')).toBeDisabled();
    await member.setViewportSize({width: 390, height: 844});
    await setTheme(member, 'light');
    const pendingStatus = member.getByRole('status').filter({hasText: 'Checking group access'});
    const pendingContrast = await measureRenderedTextContrast(pendingStatus);
    expect(pendingContrast.ratio, `light mobile pending-access contrast: ${JSON.stringify(pendingContrast)}`).toBeGreaterThanOrEqual(4.5);
    const pendingRect = await pendingStatus.boundingBox();
    const pendingSurface = await pendingStatus.evaluate(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {left: rect.left, right: rect.right, border: style.borderTopWidth, padding: style.paddingLeft, background: style.backgroundColor};
    });
    expect(pendingSurface.left, JSON.stringify(pendingSurface)).toBeGreaterThanOrEqual(8);
    expect(pendingSurface.border, JSON.stringify(pendingSurface)).not.toBe('0px');
    expect(pendingSurface.padding, JSON.stringify(pendingSurface)).toBe('14px');
    expect(pendingSurface.background, JSON.stringify(pendingSurface)).not.toBe('rgba(0, 0, 0, 0)');
    expect(pendingRect?.x).toBeGreaterThanOrEqual(0);
    expect((pendingRect?.x ?? 390) + (pendingRect?.width ?? 390)).toBeLessThanOrEqual(391);
    await member.screenshot({path: testInfo.outputPath('departure-quarantine-pending-light-390.png'), fullPage: false});
    releaseProjection();
    const alert = member.locator('.group-settings-error[role="alert"]').filter({hasText: 'The group is hidden until access is verified'});
    await expect(alert).toContainText('hidden until access is verified', {timeout: 10_000});
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
        await member.setViewportSize(viewport);
        await setTheme(member, theme);
        await expect(member.locator('.person-option').filter({hasText: 'Departure quarantine group'})).toHaveCount(0);
        await expect(member.getByRole('heading', {name: 'Departure quarantine group'})).toHaveCount(0);
        await expect(member.getByRole('region', {name: 'Message history'})).toHaveCount(0);
        await expect(member.getByText('Private departure history')).toHaveCount(0);
        await expect(member.getByText('Private departure reply')).toHaveCount(0);
        await expect(member.locator('.group-manager, .group-members, .member-actions')).toHaveCount(0);
        await expect(member.getByRole('button', {name: 'Manage group'})).toHaveCount(0);
        await expect(member.getByRole('button', {name: 'Join or start group audio call'})).toHaveCount(0);
        await expect(member.getByRole('button', {name: 'Leave group'})).toHaveCount(0);
        await expect(member.getByLabel('Message composer', {exact: true})).toHaveCount(0);
        await expect(member.locator('.composer textarea')).toBeDisabled();
        await expect(alert).toBeVisible();
        const emptyDescription = member.locator('.chat-empty p');
        await expect(emptyDescription).toBeVisible();
        const emptyContrast = await measureRenderedTextContrast(emptyDescription);
        expect(emptyContrast.ratio, `${theme} ${viewport.width}px empty-chat description contrast: ${JSON.stringify(emptyContrast)}`).toBeGreaterThanOrEqual(4.5);
        const refresh = alert.getByRole('button', {name: 'Refresh chats'});
        await expect(refresh).toBeVisible();
        await expect(refresh).toBeEnabled();
        const contrast = await measureRenderedTextContrast(refresh);
        expect(contrast.ratio, `${theme} ${viewport.width}px retry contrast: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
        const geometry = await alert.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const button = element.querySelector('button')?.getBoundingClientRect();
          return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, button: button && {left: button.left, right: button.right, top: button.top, bottom: button.bottom}, width: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, height: window.innerHeight};
        });
        expect(geometry.width, JSON.stringify({theme, viewport, geometry})).toBeLessThanOrEqual(geometry.clientWidth + 1);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 1);
        expect(geometry.button?.left).toBeGreaterThanOrEqual(geometry.left - 1);
        expect(geometry.button?.right).toBeLessThanOrEqual(geometry.right + 1);
        await member.screenshot({path: testInfo.outputPath(`departure-quarantine-error-${theme}-${viewport.width}.png`), fullPage: false});
        if (viewport.width === 390) {
          await refresh.focus();
          await member.keyboard.press('Shift+Tab');
          await member.keyboard.press('Tab');
          await expect(refresh).toBeFocused();
          const focus = await refresh.evaluate(button => getComputedStyle(button).outlineStyle);
          expect(focus).not.toBe('none');
          await member.screenshot({path: testInfo.outputPath(`departure-quarantine-retry-focus-${theme}-390.png`), fullPage: false});
        }
      }
    }
    failProjection = false;
    await member.getByRole('button', {name: 'Back to chats'}).click();
    await expect(member.locator('.conversation-rail')).toBeVisible();
    await expect(member.locator('.chat-panel')).toBeHidden();
    const railAlert = member.locator('.conversation-rail > .group-settings-error[role="alert"]');
    await expect(railAlert).toContainText('hidden until access is verified');
    await expect(railAlert.getByRole('button', {name: 'Refresh chats'})).toBeVisible();
    await member.screenshot({path: testInfo.outputPath('departure-quarantine-rail-retry-dark-390.png'), fullPage: false});
    const retry = member.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}`) && response.request().method() === 'GET');
    await railAlert.getByRole('button', {name: 'Refresh chats'}).click();
    expect((await retry).status()).toBe(404);
    await expect(railAlert).toHaveCount(0);
    await expect(member.locator('.person-option').filter({hasText: 'Departure quarantine group'})).toHaveCount(0);
    await expect(member.getByText('Private departure history')).toHaveCount(0);
    await expect(member.locator('.conversation-rail')).toBeVisible();
    const railSearchLabel = member.locator('.search-field .mdc-floating-label');
    await expect(railSearchLabel).toBeVisible();
    await expect.poll(async () => {
      const label = await railSearchLabel.boundingBox();
      const icon = await member.locator('.search-field zwei-icon').boundingBox();
      return label && icon ? label.x >= icon.x + icon.width : false;
    }, {message: 'Recovered rail search label must not overlap its icon'}).toBe(true);
    await member.screenshot({path: testInfo.outputPath('departure-quarantine-recovered-404-dark-390.png'), fullPage: false});
  } finally {
    releaseLeave();
    releaseProjection();
    await Promise.allSettled([ownerContext.close(), memberContext.close()]);
  }
});

test('manages a group through authorized UI states', async ({browser}, testInfo) => {
  test.setTimeout(240_000);
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
     const createCard = owner.locator('.group-create-card');
     const groupNameInput = createCard.getByLabel('Group name');
     const createButton = createCard.getByRole('button', {name: 'Create group'});
     // Create-form acceptance matrix: empty, whitespace validation, and filled × both themes × four widths.
     // Only the existing submission below creates a group.
     for (const theme of ['light', 'dark'] as const) {
       await setTheme(owner, theme);
       for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
         await owner.setViewportSize(viewport);
         for (const state of ['empty', 'validation', 'filled'] as const) {
           await groupNameInput.fill(state === 'validation' ? '   ' : state === 'filled' ? 'Browser acceptance group' : '');
           if (state === 'validation') {
             await createButton.click();
             await expect(createCard.getByRole('alert')).toHaveText('Enter a group name.');
             await expect(owner.getByRole('heading', {name: 'Create a group'})).toBeVisible();
           } else if (state === 'empty') {
             expect(await groupNameInput.evaluate(input => (input as HTMLInputElement).validity.valueMissing)).toBe(true);
           } else {
             await expect(groupNameInput).toHaveValue('Browser acceptance group');
           }
           await groupNameInput.focus();
           await owner.keyboard.press('Tab');
           await owner.keyboard.press('Shift+Tab');
           await expect(groupNameInput).toBeFocused();
           const geometry = await createCard.evaluate(card => {
             const panel = card.closest<HTMLElement>('.group-create-panel');
             const heading = card.querySelector<HTMLElement>('h2');
             const input = card.querySelector<HTMLInputElement>('input');
             const actions = card.querySelector<HTMLElement>('.group-create-actions');
             const buttons = Array.from(actions?.querySelectorAll<HTMLButtonElement>('button') ?? []);
             if (!panel || !heading || !input || !actions || buttons.length !== 2) throw new Error('Create-group card controls missing');
             const rect = (element: Element) => {
               const box = element.getBoundingClientRect();
               return {left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height};
             };
             const style = getComputedStyle(card);
             const inputStyle = getComputedStyle(input);
             return {
               panel: rect(panel), card: rect(card), heading: rect(heading), input: rect(input), actions: rect(actions),
               buttons: buttons.map(rect), documentWidth: document.documentElement.scrollWidth,
               viewportWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight,
               surface: style.backgroundColor, borderWidth: style.borderTopWidth, borderStyle: style.borderTopStyle,
               inputSurface: inputStyle.backgroundColor, inputBorder: inputStyle.borderTopWidth,
               focus: {style: inputStyle.outlineStyle, width: inputStyle.outlineWidth, offset: inputStyle.outlineOffset},
             };
           });
           const context = `${theme}/${viewport.width}px group create ${state}: ${JSON.stringify(geometry)}`;
           expect(geometry.documentWidth, context).toBeLessThanOrEqual(geometry.viewportWidth + 1);
           expect(geometry.card.left, context).toBeGreaterThanOrEqual(geometry.panel.left - 1);
           expect(geometry.card.right, context).toBeLessThanOrEqual(geometry.panel.right + 1);
           expect(geometry.card.bottom, context).toBeLessThanOrEqual(geometry.viewportHeight + 1);
           expect(geometry.heading.top, context).toBeGreaterThanOrEqual(geometry.card.top);
           expect(geometry.heading.bottom, context).toBeLessThanOrEqual(geometry.input.top);
           expect(geometry.input.left, context).toBeGreaterThanOrEqual(geometry.card.left);
           expect(geometry.input.right, context).toBeLessThanOrEqual(geometry.card.right + 1);
           expect(geometry.input.bottom, context).toBeLessThanOrEqual(geometry.actions.top);
           expect(geometry.buttons, context).toHaveLength(2);
           for (const button of geometry.buttons) {
             expect(button.width, context).toBeGreaterThan(0);
             expect(button.height, context).toBeGreaterThanOrEqual(40);
             expect(button.left, context).toBeGreaterThanOrEqual(geometry.card.left);
             expect(button.right, context).toBeLessThanOrEqual(geometry.card.right + 1);
             expect(button.top, context).toBeGreaterThanOrEqual(geometry.actions.top - 1);
             expect(button.bottom, context).toBeLessThanOrEqual(geometry.card.bottom + 1);
           }
           expect(geometry.buttons[0].right, context).toBeLessThanOrEqual(geometry.buttons[1].left);
            expect(geometry.borderStyle, context).toBe('solid');
            expect(Number.parseFloat(geometry.borderWidth), context).toBeGreaterThan(0);
            expect(Number.parseFloat(geometry.inputBorder), context).toBeGreaterThan(0);
            expect(geometry.surface, context).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(32, 44, 59)');
            expect(geometry.inputSurface, context).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(32, 46, 61)');
            const expectedBorder = theme === 'light' ? 'rgb(207, 217, 232)' : 'rgb(48, 70, 94)';
            const borderColors = await createCard.evaluate(card => ({
              card: getComputedStyle(card).borderTopColor,
              input: getComputedStyle(card.querySelector('input') ?? card).borderTopColor,
            }));
            expect(borderColors, context).toEqual({card: expectedBorder, input: expectedBorder});
           expect(geometry.focus.style, context).not.toBe('none');
           expect(Number.parseFloat(geometry.focus.width), context).toBeGreaterThan(0);
           const focusInset = Number.parseFloat(geometry.focus.width) + Number.parseFloat(geometry.focus.offset);
           expect(geometry.input.left - focusInset, context).toBeGreaterThanOrEqual(geometry.card.left - 1);
           expect(geometry.input.right + focusInset, context).toBeLessThanOrEqual(geometry.card.right + 1);
           expect(geometry.input.bottom + focusInset, context).toBeLessThanOrEqual(geometry.actions.top);
            for (const text of [createCard.locator('h2'), createCard.locator('label'), createCard.locator('.group-create-actions button').first()]) {
              const contrast = await measureRenderedTextContrastAtSurface(text);
              expect(contrast.ratio, `${context} text contrast: ${JSON.stringify(contrast)}`).toBeGreaterThanOrEqual(4.5);
            }
            if (state === 'empty') {
              const placeholderContrast = await measureRenderedTextContrastAtSurface(groupNameInput, '::placeholder');
              expect(placeholderContrast.opacity, `${context} placeholder opacity: ${JSON.stringify(placeholderContrast)}`).toBe(1);
              expect(placeholderContrast.ratio, `${context} placeholder contrast: ${JSON.stringify(placeholderContrast)}`).toBeGreaterThanOrEqual(4.5);
            }
            if (state === 'validation') {
              const validationError = createCard.getByRole('alert');
              const errorContrast = await measureRenderedTextContrastAtSurface(validationError);
              expect(errorContrast.ratio, `${context} validation contrast: ${JSON.stringify(errorContrast)}`).toBeGreaterThanOrEqual(4.5);
            }
           await owner.screenshot({path: testInfo.outputPath(`group-create-${state}-${theme}-${viewport.width}.png`), fullPage: false});
            if (state === 'validation') {
              await createCard.getByRole('button', {name: 'Cancel'}).click();
              await expect(createCard).toHaveCount(0);
              await owner.locator('.new-group-button').click();
              await expect(createCard.getByRole('alert')).toHaveCount(0);
           }
         }
         await owner.emulateMedia({reducedMotion: 'reduce'});
         expect(await owner.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
         const reducedMotion = await createCard.evaluate(card => {
           const style = getComputedStyle(card.querySelector('input') ?? card);
           return {transition: style.transitionDuration, animation: style.animationDuration};
         });
         expect(reducedMotion.transition.split(',').every(duration => Number.parseFloat(duration) <= .01), JSON.stringify(reducedMotion)).toBe(true);
         expect(reducedMotion.animation.split(',').every(duration => Number.parseFloat(duration) <= .01), JSON.stringify(reducedMotion)).toBe(true);
         await owner.emulateMedia({reducedMotion: null});
       }
     }
     await owner.setViewportSize({width: 2560, height: 1440});
     await setTheme(owner, 'dark');
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
    await setTheme(owner, 'dark');
    const memberSearch = owner.getByLabel('Find a person');
    await memberSearch.fill(memberEmail);
    await expect(owner.getByRole('option', {name: new RegExp(memberEmail)})).toBeVisible();
    await expect(owner.locator('.group-manager .group-search-status[role="status"]')).toHaveText('1 person found.');

    const emptyQuery = `empty-search-${Date.now()}`;
    let releaseEmptyResponse = (): void => {};
    let emptyRequestStarted = (): void => {};
    const emptyResponseGate = new Promise<void>(resolve => { releaseEmptyResponse = resolve; });
    const emptyRequest = new Promise<void>(resolve => { emptyRequestStarted = resolve; });
    await owner.route('**/api/chat/users/search?*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') !== emptyQuery) return route.fallback();
      emptyRequestStarted();
      await emptyResponseGate;
      await route.fulfill({status: 200, contentType: 'application/json', body: '[]'});
    });
    await memberSearch.fill(emptyQuery);
    await emptyRequest;
    const searchStatus = owner.locator('.group-search-status');
    await expect(searchStatus).toHaveRole('status');
    await expect(searchStatus).toHaveText('Searching people…');
    await expect(owner.getByRole('option')).toHaveCount(0);
    await owner.screenshot({path: testInfo.outputPath('group-member-search-loading-dark-desktop.png'), fullPage: false});
    releaseEmptyResponse();
    await expect(searchStatus).toHaveText('No people found. Try another name or email.');
    await expect(owner.getByRole('option')).toHaveCount(0);
    await owner.screenshot({path: testInfo.outputPath('group-member-search-empty-dark-desktop.png'), fullPage: false});

    const errorQuery = `error-search-${Date.now()}`;
    let releaseErrorResponse = (): void => {};
    let errorRequestStarted = (): void => {};
    const errorResponseGate = new Promise<void>(resolve => { releaseErrorResponse = resolve; });
    const errorRequest = new Promise<void>(resolve => { errorRequestStarted = resolve; });
    await owner.route('**/api/chat/users/search?*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') !== errorQuery) return route.fallback();
      errorRequestStarted();
      await errorResponseGate;
      await route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({error: 'deterministic search failure'})});
    });
    await memberSearch.fill(errorQuery);
    await errorRequest;
    await expect(searchStatus).toHaveRole('status');
    await expect(searchStatus).toHaveText('Searching people…');
    await expect(owner.getByRole('option')).toHaveCount(0);
    releaseErrorResponse();
    const searchAlert = owner.locator('.group-search-status[role="alert"]');
    await expect(searchAlert).toHaveText('Could not search for people. Try again.');
    await expect(owner.getByRole('option')).toHaveCount(0);
    await owner.screenshot({path: testInfo.outputPath('group-member-search-error-dark-desktop.png'), fullPage: false});
    await owner.unroute('**/api/chat/users/search?*');

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
    await expect(owner.getByRole('heading', {name: 'Browser acceptance group'})).toHaveCount(0);
    await expect(owner.locator('.person-option').filter({hasText: 'Browser acceptance group'})).toHaveCount(0);
    await expect(owner.locator('.message-history')).toHaveCount(0);
    await expect(owner.getByText(firstGroupMessage, {exact: true})).toHaveCount(0);
    await expect(owner.locator('.group-manager, .group-members, .member-actions')).toHaveCount(0);
    await expect(owner.getByRole('button', {name: 'Join or start group audio call'})).toHaveCount(0);
    await expect(owner.locator('.composer textarea')).toBeDisabled();
    await expect(owner.getByRole('button', {name: 'Refresh chats'})).toBeVisible();
    await owner.screenshot({path: testInfo.outputPath('group-projection-transient-error-dark.png'), fullPage: false, timeout: 15_000});
    await owner.unroute(`**/api/chat/groups/${groupID}`);
    await owner.getByRole('button', {name: 'Refresh chats'}).click();
    await expect(owner.locator('.group-settings-error')).toHaveCount(0, {timeout: 10_000});
    await expect(owner.getByRole('heading', {name: 'Browser acceptance group'})).toBeVisible();
    await expect(owner.getByText(firstGroupMessage, {exact: true})).toBeVisible({timeout: 10_000});
    await owner.getByRole('button', {name: 'Manage group'}).click();
    await expect(owner.locator('.group-manager')).toBeVisible();
    const memberRow = owner.locator('.group-members li').filter({has: owner.locator('.member-identity strong').filter({hasText: /^Member$/})});
    await expect(memberRow.locator('.member-identity small')).toHaveText('member', {timeout: 10_000});
    await expect(owner.getByRole('button', {name: 'Join or start group audio call'})).toBeVisible();
    const restoreAdmin = await ownerContext.request.patch(`${chatBase}/api/chat/groups/${groupID}/members/${memberIDs.get(memberEmail)}`, {
      headers: {Authorization: `${ownerToken.token_type} ${ownerToken.access_token}`},
      data: {role: 'admin'},
    });
    expect(restoreAdmin.status()).toBe(200);
    await owner.reload();
    const ownerGroupOption = owner.locator('.person-option').filter({hasText: 'Browser acceptance group'});
    await expect(ownerGroupOption).toBeVisible({timeout: 10_000});
    await ownerGroupOption.click();
    await expect(owner.getByRole('heading', {name: 'Browser acceptance group'})).toBeVisible();
    await owner.getByRole('button', {name: 'Manage group'}).click();
    await expect(owner.locator('.group-manager')).toBeVisible();
    await expect(memberRow.locator('.member-identity small')).toHaveText('admin', {timeout: 10_000});
    await expect(owner.locator('.group-manager form').getByRole('button', {name: 'Save name'})).toBeEnabled();

    await owner.route(`**/api/chat/groups/${groupID}`, route => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({status: 500, contentType: 'application/json', body: '{"error":"test failure"}'});
      }
      return route.fallback();
    });
    const groupReadWhileRouteInstalled = await owner.evaluate(async ({groupID, authorization}) => {
      const response = await fetch(`/api/chat/groups/${groupID}`, {headers: {Authorization: authorization}});
      return {status: response.status, body: await response.text()};
    }, {groupID, authorization: `${ownerToken.token_type} ${ownerToken.access_token}`});
    expect(groupReadWhileRouteInstalled.status).toBe(200);
    expect(groupReadWhileRouteInstalled.body).toBeTruthy();
    await owner.getByLabel('Name', {exact: true}).fill('Rejected rename');
    const rejectedRename = owner.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}`) && response.request().method() === 'PATCH');
    await owner.locator('.group-manager form').getByRole('button', {name: 'Save name'}).click();
    expect((await rejectedRename).status()).toBe(500);
    await expect(owner.getByRole('alert')).toHaveText('Group changes could not be saved.');
    await owner.unroute(`**/api/chat/groups/${groupID}`);
    await expect(owner.locator('.group-manager')).toBeVisible();
    await owner.getByLabel('Name', {exact: true}).fill('Browser acceptance group renamed');
    const successfulRename = owner.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}`) && response.request().method() === 'PATCH');
    await owner.locator('.group-manager form').getByRole('button', {name: 'Save name'}).click();
    expect((await successfulRename).status()).toBe(200);
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
    await owner.locator('.group-manager-heading').getByRole('button', {name: 'Close group settings'}).click();
    const systemMessages = async (page: Page, participant: 'actor' | 'recipient', theme: 'light' | 'dark', viewport: {width: number; height: number}, expectedCopy: readonly string[]): Promise<void> => {
      await page.setViewportSize(viewport);
      await setTheme(page, theme);
      await expect(page.locator('.group-manager')).toHaveCount(0);
      const notices = page.locator('.message-bubble.message-system');
      const groupComposer = page.getByPlaceholder('Write a message…');
      for (const copy of expectedCopy) {
        const notice = notices.filter({hasText: copy});
        await expect(notice).toHaveCount(1);
        await expect(notice).not.toHaveClass(/message-own/);
        await expect(notice.locator('.message-read')).toHaveCount(0);
        await expect(notice.locator('.message-sender')).toHaveCount(0);
        const colors = await notice.evaluate(element => ({surface: getComputedStyle(element).backgroundColor, text: getComputedStyle(element.querySelector('p')!).color, time: getComputedStyle(element.querySelector('time')!).color, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right}));
        await expect(notice).toHaveCSS('align-self', 'center');
        expect(colors.surface, `${theme}/${viewport.width} ${copy} theme surface`).toBe(theme === 'light' ? 'rgb(232, 241, 251)' : 'rgb(38, 57, 79)');
        const textContrast = await measureRenderedTextContrast(notice.locator('p'));
        const timeContrast = await measureRenderedTextContrast(notice.locator('time'));
        expect(textContrast.ratio, `${theme}/${viewport.width} ${copy} contrast ${JSON.stringify({colors, textContrast})}`).toBeGreaterThanOrEqual(4.5);
        expect(timeContrast.ratio, `${theme}/${viewport.width} ${copy} timestamp contrast ${JSON.stringify({colors, timeContrast})}`).toBeGreaterThanOrEqual(4.5);
        expect(colors.left).toBeGreaterThanOrEqual(0);
        expect(colors.right).toBeLessThanOrEqual(viewport.width + 1);
        const noticeBox = await notice.boundingBox();
        const composerBox = await groupComposer.boundingBox();
        if (!noticeBox || !composerBox) throw new Error(`${theme}/${viewport.width} system message/composer geometry unavailable`);
        expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(composerBox.y + 1);
      }
      await expect(page.locator('.mat-mdc-snack-bar-container')).toHaveCount(0);
        const history = page.locator('.message-history');
        const edgeVisibility = await history.evaluate(element => {
          const scroller = element as HTMLElement;
          const notices = Array.from(scroller.querySelectorAll<HTMLElement>('.message-bubble.message-system'));
          const measure = (rect: DOMRect, bounds: DOMRect) => ({top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, visible: rect.bottom > bounds.top && rect.top < bounds.bottom && rect.left >= bounds.left && rect.right <= bounds.right});
          const bounds = scroller.getBoundingClientRect();
          scroller.scrollTop = 0;
          const top = {scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, first: notices[0] ? measure(notices[0].getBoundingClientRect(), bounds) : undefined};
          scroller.scrollTop = scroller.scrollHeight;
          const end = {scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, last: notices.at(-1) ? measure(notices.at(-1)!.getBoundingClientRect(), bounds) : undefined};
          return {top, end, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, documentScrollWidth: document.documentElement.scrollWidth, documentClientWidth: document.documentElement.clientWidth};
        });
        expect(edgeVisibility.top.first?.visible, `${theme}/${viewport.width} first system notice visible at history top: ${JSON.stringify(edgeVisibility)}`).toBeTruthy();
        expect(edgeVisibility.end.last?.visible, `${theme}/${viewport.width} last system notice visible at history end: ${JSON.stringify(edgeVisibility)}`).toBeTruthy();
        expect(edgeVisibility.end.scrollTop + edgeVisibility.end.clientHeight, JSON.stringify(edgeVisibility)).toBeGreaterThanOrEqual(edgeVisibility.end.scrollHeight - 1);
        expect(edgeVisibility.scrollWidth).toBeLessThanOrEqual(edgeVisibility.clientWidth + 1);
        expect(edgeVisibility.documentScrollWidth).toBeLessThanOrEqual(edgeVisibility.documentClientWidth + 1);
        await expect(page.locator('.message-history')).toHaveJSProperty('scrollTop', edgeVisibility.end.scrollTop);
        await page.locator('.message-history').evaluate(element => { (element as HTMLElement).scrollTop = 0; });
        await page.screenshot({path: testInfo.outputPath(`group-system-messages-${participant}-${theme}-${viewport.width}-top.png`), fullPage: false});
        await page.locator('.message-history').evaluate(element => { const scroller = element as HTMLElement; scroller.scrollTop = scroller.scrollHeight; });
        await page.screenshot({path: testInfo.outputPath(`group-system-messages-${participant}-${theme}-${viewport.width}-end.png`), fullPage: false});
    };
    for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
      for (const theme of ['light', 'dark'] as const) {
        await systemMessages(owner, 'actor', theme, viewport, ['Owner added Member to the group.']);
        await systemMessages(member, 'recipient', theme, viewport, ['Owner added Member to the group.']);
      }
    }
    await owner.setViewportSize({width: 1440, height: 900});
    await member.setViewportSize({width: 390, height: 844});
    const groupMessage = `attributed-message-${Date.now()}`;
    await member.getByPlaceholder('Write a message…').fill(groupMessage);
    await member.getByRole('button', {name: 'Send message'}).click();
    const received = owner.locator('.message-bubble').filter({hasText: groupMessage});
    await expect(received).toBeVisible({timeout: 10_000});
    await expect(received.locator('.message-sender')).toHaveText('Member');
    await expect(received).not.toHaveClass(/message-own/);
    const ownMessage = member.locator('.message-bubble').filter({hasText: groupMessage});
    await expect(ownMessage).toHaveClass(/message-own/);
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
        await member.setViewportSize(viewport);
        await setTheme(member, theme);
        const ownSenderContrast = await measureRenderedTextContrast(ownMessage.locator('.message-sender'));
        const ownTimeContrast = await measureRenderedTextContrast(ownMessage.locator('time'));
        expect(ownSenderContrast.ratio, `${theme}/${viewport.width} own group-message sender contrast: ${JSON.stringify(ownSenderContrast)}`).toBeGreaterThanOrEqual(4.5);
        expect(ownTimeContrast.ratio, `${theme}/${viewport.width} own group-message timestamp contrast: ${JSON.stringify(ownTimeContrast)}`).toBeGreaterThanOrEqual(4.5);
        await member.screenshot({path: testInfo.outputPath(`group-own-message-metadata-${theme}-${viewport.width}.png`), fullPage: false});
      }
    }
    await member.setViewportSize({width: 390, height: 844});
    await setTheme(member, 'light');
    await owner.getByRole('button', {name: 'Manage group'}).click();
    await owner.locator('.group-members li').filter({hasText: 'Member'}).getByRole('button', {name: /Make Member an admin/}).click();
    await expect(member.getByText('Owner made Member an admin.', {exact: true})).toBeVisible({timeout: 10_000});
    await owner.locator('.group-manager-heading').getByRole('button', {name: 'Close group settings'}).click();

    for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
      for (const theme of ['light', 'dark'] as const) {
        await systemMessages(owner, 'actor', theme, viewport, ['Owner added Member to the group.', 'Owner made Member an admin.']);
        await systemMessages(member, 'recipient', theme, viewport, ['Owner added Member to the group.', 'Owner made Member an admin.']);
      }
    }

    for (const page of [owner, member]) {
      await page.setViewportSize({width: 1440, height: 900});
      await page.evaluate(() => window.localStorage.removeItem('zwei_selected_conversation'));
      await page.reload();
      await expect(page).toHaveURL(/\/home$/);
      await expect(page.getByRole('button', {name: 'Account menu'})).toBeVisible();
      await expect(page.getByRole('heading', {name: 'Choose a conversation'})).toBeVisible();
      const unselectedComposer = page.locator('.composer textarea');
      await expect(unselectedComposer).toHaveAttribute('placeholder', 'Choose a chat to start messaging');
      await expect(unselectedComposer).toBeDisabled();
      await expect(page.locator('.person-option.selected')).toHaveCount(0);
      await expect(page.locator('.group-manager')).toHaveCount(0);
      await waitForLiveConnection(page);
      await page.locator('.person-option').filter({hasText: 'Attribution group'}).click();
      await expect(page.getByText('Owner added Member to the group.', {exact: true})).toBeVisible();
      await expect(page.getByText('Owner made Member an admin.', {exact: true})).toBeVisible();
      const reloadedSystemNotices = page.locator('.message-bubble.message-system');
      await expect(reloadedSystemNotices).toHaveCount(2);
      for (const copy of ['Owner added Member to the group.', 'Owner made Member an admin.']) {
        const notice = reloadedSystemNotices.filter({hasText: copy});
        await expect(notice).toHaveCount(1);
        await expect(notice).not.toHaveClass(/message-own/);
        await expect(notice.locator('.message-read')).toHaveCount(0);
      }
      await expect(page.locator('.group-manager')).toHaveCount(0);
      await page.screenshot({path: testInfo.outputPath(`group-system-messages-reloaded-${page === owner ? 'actor' : 'recipient'}-1440.png`), fullPage: false});
    }

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

test('keeps long People search scrollable and keyboard-accessible across themes and viewports', async ({browser}, testInfo) => {
  const ownerContext = await browser.newContext({viewport: {width: 2560, height: 1440}});
  const owner = await ownerContext.newPage();
  const people = Array.from({length: 11}, (_, index) => ({
    id: `search-result-user-${index}`,
    display_name: `Member ${index}`,
    email: `e2e-search-member-${index}@example.test`,
  }));
  const conversationFor = (person: typeof people[number]) => ({
    id: `search-conversation-${person.id}`, other_user_id: person.id, other_display_name: person.display_name,
    other_email: person.email, created_at: new Date().toISOString(),
  });
  await owner.route('**/api/chat/users/search**', route => route.fulfill({json: people}));
  await owner.route('**/api/chat/conversations', async route => {
    if (route.request().method() === 'GET') return route.fulfill({json: [conversationFor(people[0])]});
    if (route.request().method() !== 'POST') return route.continue();
    const payload = route.request().postDataJSON() as {other_user_id?: string};
    const person = people.find(candidate => candidate.id === payload.other_user_id);
    if (!person) return route.fulfill({status: 400, contentType: 'application/json', body: JSON.stringify({error: 'unknown test user'})});
    return route.fulfill({status: 201, contentType: 'application/json', body: JSON.stringify(conversationFor(person))});
  });
  try {
    await owner.goto('/login');
    await login(owner, adminEmail);
    await waitForLiveConnection(owner);
    const peopleSearch = owner.getByPlaceholder('Name or email');
    await peopleSearch.fill('e2e-search-member');
    const searchResults = owner.locator('.search-results');
    await expect(owner.locator('.group-search-status')).toContainText('11 people found.');
    await expect(searchResults.locator('.search-result')).toHaveCount(11);
    await searchResults.locator('.search-result').first().click();
    await expect(owner.locator('.chat-header h2')).toHaveText('Member 0');
    await owner.setViewportSize({width: 390, height: 844});
    await owner.getByRole('button', {name: 'Back to chats'}).click();
    await peopleSearch.fill('e2e-search-member');
    await owner.setViewportSize({width: 2560, height: 1440});

    for (const theme of ['dark', 'light'] as const) {
      for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
        await owner.setViewportSize(viewport);
        const conversationOpen = await owner.locator('.workspace.conversation-open').count() > 0;
        if (viewport.width === 390 && conversationOpen) {
          await owner.getByRole('button', {name: 'Back to chats'}).click();
        } else if (viewport.width > 760 && !conversationOpen) {
          await owner.locator('.person-option').filter({hasText: 'Member 0'}).click();
        }
        await setTheme(owner, theme);
        await expect(searchResults, `${theme}/${viewport.width}px People search results`).toBeVisible();
        await expect(searchResults.locator('.search-result')).toHaveCount(people.length);
        const orderedResults = await searchResults.locator('.search-result').evaluateAll(results => results.map(result => result.textContent ?? ''));
        for (const [index, person] of people.entries()) expect(orderedResults[index]).toContain(person.display_name);
        await searchResults.locator('.search-result').first().scrollIntoViewIfNeeded();
        const searchGeometry = await searchResults.evaluate(results => {
          const rail = results.closest<HTMLElement>('.conversation-rail');
          const heading = rail?.querySelector<HTMLElement>('.rail-heading');
          const input = rail?.querySelector<HTMLElement>('.search-field');
          const status = rail?.querySelector<HTMLElement>('.group-search-status');
          const chatLabel = rail?.querySelector<HTMLElement>('.rail-label');
          const firstConversation = rail?.querySelector<HTMLElement>('.people-list .person-option');
          const rect = (element?: HTMLElement) => {
            const bounds = element?.getBoundingClientRect();
            return bounds && {left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height};
          };
          return {
            results: rect(results), heading: rect(heading), input: rect(input), status: rect(status), chatLabel: rect(chatLabel), firstConversation: rect(firstConversation),
            scrollTop: results.scrollTop, scrollHeight: results.scrollHeight, clientHeight: results.clientHeight,
            scrollWidth: results.scrollWidth, clientWidth: results.clientWidth,
            firstResult: rect(results.querySelector<HTMLElement>('.search-result') ?? undefined),
            lastResult: rect(results.querySelector<HTMLElement>('.search-result:last-child') ?? undefined),
            surface: getComputedStyle(results).backgroundColor, maxHeight: getComputedStyle(results).maxHeight,
            overflowY: getComputedStyle(results).overflowY,
            railScrollWidth: rail?.scrollWidth, railClientWidth: rail?.clientWidth,
            documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
          };
        });
        const context = `${theme}/${viewport.width}px People search: ${JSON.stringify(searchGeometry)}`;
        expect(searchGeometry.scrollHeight, context).toBeGreaterThan(searchGeometry.clientHeight);
        expect(searchGeometry.clientHeight, context).toBeLessThanOrEqual(Math.min(576, viewport.height * 0.52) + 1);
        expect(Number.parseFloat(searchGeometry.maxHeight), context).toBeCloseTo(Math.min(576, viewport.height * 0.52), 1);
        expect(searchGeometry.overflowY, context).toBe('auto');
        expect(searchGeometry.scrollTop, context).toBe(0);
        expect(searchGeometry.results?.top, context).toBeGreaterThanOrEqual(0);
        expect(searchGeometry.results?.bottom, context).toBeLessThanOrEqual(viewport.height + 1);
        expect(searchGeometry.results?.top, context).toBeGreaterThanOrEqual((searchGeometry.status?.bottom ?? 0) + 8);
        expect(searchGeometry.firstResult?.top, context).toBeGreaterThanOrEqual((searchGeometry.results?.top ?? 0) - 1);
        expect(searchGeometry.firstResult?.bottom, context).toBeLessThanOrEqual((searchGeometry.results?.bottom ?? 0) + 1);
        expect(searchGeometry.lastResult?.bottom, context).toBeGreaterThan((searchGeometry.results?.bottom ?? 0) + 1);
        expect(searchGeometry.heading?.bottom, context).toBeLessThanOrEqual((searchGeometry.results?.top ?? 0) + 1);
        expect(searchGeometry.input?.bottom, context).toBeLessThanOrEqual((searchGeometry.results?.top ?? 0) + 1);
        expect(searchGeometry.chatLabel?.bottom, context).toBeLessThanOrEqual(viewport.height + 1);
        expect(searchGeometry.chatLabel?.top, context).toBeGreaterThanOrEqual(0);
        expect(searchGeometry.firstConversation?.bottom, context).toBeLessThanOrEqual(viewport.height + 1);
        expect(searchGeometry.firstConversation?.top, context).toBeGreaterThanOrEqual(0);
        expect(searchGeometry.scrollWidth, context).toBeLessThanOrEqual(searchGeometry.clientWidth + 1);
        expect(searchGeometry.railScrollWidth, context).toBeLessThanOrEqual((searchGeometry.railClientWidth ?? 0) + 1);
        expect(searchGeometry.documentWidth, context).toBeLessThanOrEqual(searchGeometry.viewportWidth + 1);
        await owner.screenshot({path: testInfo.outputPath(`people-search-results-${theme}-${viewport.width}-top.png`), fullPage: false});

        const firstResult = searchResults.locator('.search-result').first();
        const lastResult = searchResults.locator('.search-result').last();
        await firstResult.focus();
        for (let tab = 1; tab < people.length; tab += 1) await owner.keyboard.press('Tab');
        await expect(lastResult, `${context} keyboard focus should reach the final result`).toBeFocused();
        const searchEnd = await searchResults.evaluate(results => {
          const last = results.querySelector<HTMLElement>('.search-result:last-child');
          const bounds = last?.getBoundingClientRect();
          const region = results.getBoundingClientRect();
          const resultStyle = last ? getComputedStyle(last) : undefined;
          const outlineWidth = Number.parseFloat(resultStyle?.outlineWidth ?? '0');
          const outlineOffset = Number.parseFloat(resultStyle?.outlineOffset ?? '0');
          const borderTop = Number.parseFloat(getComputedStyle(results).borderTopWidth);
          const borderBottom = Number.parseFloat(getComputedStyle(results).borderBottomWidth);
          const rail = results.closest<HTMLElement>('.conversation-rail');
          const statusRect = rail?.querySelector<HTMLElement>('.group-search-status')?.getBoundingClientRect();
          const firstVisibleResult = Array.from(results.querySelectorAll<HTMLElement>('.search-result')).find(result => result.getBoundingClientRect().bottom > region.top);
          const firstVisibleRect = firstVisibleResult?.getBoundingClientRect();
          return {
            scrollTop: results.scrollTop, scrollHeight: results.scrollHeight, clientHeight: results.clientHeight,
            region: {top: region.top, bottom: region.bottom},
            status: statusRect && {top: statusRect.top, bottom: statusRect.bottom},
            firstVisibleResult: firstVisibleRect && {top: firstVisibleRect.top, bottom: firstVisibleRect.bottom},
            lastResult: bounds && {top: bounds.top, bottom: bounds.bottom},
            focusRing: bounds && resultStyle && {
              style: resultStyle.outlineStyle, width: outlineWidth,
              top: bounds.top - outlineOffset - outlineWidth, bottom: bounds.bottom + outlineOffset + outlineWidth,
              clipTop: region.top + borderTop, clipBottom: region.bottom - borderBottom,
            },
            documentWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth,
          };
        });
        expect(searchEnd.scrollTop, `${context} keyboard focus should scroll within results: ${JSON.stringify(searchEnd)}`).toBeGreaterThan(0);
        expect(searchEnd.region.top, context).toBeGreaterThanOrEqual((searchEnd.status?.bottom ?? 0) + 8);
        expect(searchEnd.lastResult?.top, context).toBeGreaterThanOrEqual(searchEnd.region.top - 1);
        expect(searchEnd.lastResult?.bottom, context).toBeLessThanOrEqual(searchEnd.region.bottom + 1);
        expect(searchEnd.focusRing?.style, `${context} focused result should have a visible outline`).not.toBe('none');
        expect(searchEnd.focusRing?.width, `${context} focused result should have a visible outline`).toBeGreaterThan(0);
        expect(searchEnd.focusRing?.top, `${context} focused result outline should remain inside the scrollport`).toBeGreaterThanOrEqual(searchEnd.focusRing?.clipTop ?? 0);
        expect(searchEnd.focusRing?.bottom, `${context} focused result outline should remain inside the scrollport`).toBeLessThanOrEqual(searchEnd.focusRing?.clipBottom ?? 0);
        expect(searchEnd.documentWidth, context).toBeLessThanOrEqual(searchEnd.viewportWidth + 1);
        await owner.screenshot({path: testInfo.outputPath(`people-search-results-${theme}-${viewport.width}-keyboard-end.png`), fullPage: false});
        if (theme === 'light' && viewport.width === 390) {
          await lastResult.press('Enter');
          await expect(owner.locator('.chat-header h2')).toHaveText('Member 10', {timeout: 10_000});
          await owner.screenshot({path: testInfo.outputPath('people-search-result-keyboard-activation-light-390.png'), fullPage: false});
          await owner.getByRole('button', {name: 'Back to chats'}).click();
          await expect(peopleSearch).toBeVisible();
        }
      }
    }
  } finally {
    await ownerContext.close();
  }
});

test('contains group member, message, and rail lists across the required viewports and themes', async ({browser}, testInfo) => {
  // This flow provisions 12 accounts, then exercises multi-region scrolling,
  // member actions, and screenshots across both themes and four viewports.
  // The isolated Docker CI runner needs more time than the local browser.
  test.setTimeout(600_000);
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
    await owner.setViewportSize({width: 2560, height: 1440});
    await setTheme(owner, 'dark');
    if (!(await owner.locator('.workspace.conversation-open').count())) await owner.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'}).click();
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
    const adminContext = await browser.newContext({viewport: {width: 1440, height: 900}});
    try {
      const groupAdmin = await adminContext.newPage();
      await groupAdmin.goto('/login');
      await login(groupAdmin, memberEmails[0]);
      await waitForLiveConnection(groupAdmin);
      await expect(groupAdmin.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'})).toBeVisible();
      await groupAdmin.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'}).click();
      await groupAdmin.getByRole('button', {name: 'Manage group'}).click();
      await expect(groupAdmin.locator('.group-manager')).toBeVisible();
      for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
        for (const theme of ['dark', 'light'] as const) {
          await groupAdmin.setViewportSize(viewport);
          await setTheme(groupAdmin, theme);
          const adminList = groupAdmin.locator('.group-members');
          const adminGapMetrics = await adminList.evaluate(list => {
            const scroller = list as HTMLElement;
            scroller.scrollTop = 0;
            const bounds = (element: HTMLElement) => {
              const rect = element.getBoundingClientRect();
              return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
            };
            const rows = Array.from(scroller.querySelectorAll<HTMLElement>(':scope > li'));
            return {
              gaps: rows.slice(0, -1).map((row, index) => rows[index + 1].getBoundingClientRect().top - row.getBoundingClientRect().bottom),
              rowGap: getComputedStyle(scroller).rowGap,
              rowCount: rows.length,
              scrollHeight: scroller.scrollHeight,
              clientHeight: scroller.clientHeight,
              scrollWidth: scroller.scrollWidth,
              clientWidth: scroller.clientWidth,
              scrollTop: scroller.scrollTop,
              list: bounds(scroller),
              firstRow: rows[0] && bounds(rows[0]),
              firstActionsContained: rows[0] && Array.from(rows[0].querySelectorAll<HTMLElement>('.member-action-button')).every(button => {
                const buttonRect = button.getBoundingClientRect();
                const rowRect = rows[0].getBoundingClientRect();
                return buttonRect.left >= rowRect.left - 1 && buttonRect.right <= rowRect.right + 1 && buttonRect.top >= rowRect.top - 1 && buttonRect.bottom <= rowRect.bottom + 1;
              }),
            };
          });
          const expectedGap = viewport.width <= 760 ? 18 : 14.5;
          expect(adminGapMetrics.rowCount).toBeGreaterThan(1);
          expect(Math.max(...adminGapMetrics.gaps) - Math.min(...adminGapMetrics.gaps)).toBeLessThanOrEqual(1);
          for (const gap of adminGapMetrics.gaps) expect(Math.abs(gap - expectedGap), `${theme}/${viewport.width}px admin card gaps ${JSON.stringify(adminGapMetrics)}`).toBeLessThanOrEqual(1);
          expect(adminGapMetrics.scrollWidth).toBeLessThanOrEqual(adminGapMetrics.clientWidth + 1);
          expect(adminGapMetrics.scrollTop).toBe(0);
          expect(adminGapMetrics.firstRow?.top).toBeGreaterThanOrEqual(adminGapMetrics.list.top - 1);
          expect(adminGapMetrics.firstRow?.bottom).toBeLessThanOrEqual(adminGapMetrics.list.bottom + 1);
          expect(adminGapMetrics.firstActionsContained).toBeTruthy();
          await groupAdmin.screenshot({path: testInfo.outputPath(`group-settings-admin-${theme}-${viewport.width}-members-top.png`), fullPage: false});
          const adminEndMetrics = await adminList.evaluate(async list => {
            const scroller = list as HTMLElement;
            scroller.scrollTop = scroller.scrollHeight;
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            const rows = Array.from(scroller.querySelectorAll<HTMLElement>(':scope > li'));
            const lastRow = rows[rows.length - 1];
            let listRect = scroller.getBoundingClientRect();
            const paddingBottom = Number.parseFloat(getComputedStyle(scroller).paddingBottom);
            let alignmentAdjustment = 0;
            const firstVisibleRow = rows.find(row => row.getBoundingClientRect().bottom > listRect.top);
            const firstVisibleRect = firstVisibleRow?.getBoundingClientRect();
            if (firstVisibleRect && firstVisibleRect.top < listRect.top) {
              const clippedTop = listRect.top - firstVisibleRect.top;
              if (clippedTop > paddingBottom + 1) throw new Error(`End alignment exceeds member-list bottom-padding allowance: ${JSON.stringify({clippedTop, paddingBottom})}`);
              alignmentAdjustment = clippedTop;
              scroller.scrollTop -= clippedTop - 0.7;
              await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
              listRect = scroller.getBoundingClientRect();
            }
            const rowRect = lastRow.getBoundingClientRect();
            const actions = Array.from(lastRow.querySelectorAll<HTMLElement>('.member-action-button')).map(button => button.getBoundingClientRect());
            const visibleRows = rows.filter(row => {
              const rect = row.getBoundingClientRect();
              return rect.bottom > listRect.top && rect.top < listRect.bottom;
            }).map(row => {
              const rect = row.getBoundingClientRect();
              return {name: row.querySelector('.member-identity strong')?.textContent?.trim(), top: rect.top, bottom: rect.bottom, fullyVisible: rect.top >= listRect.top - 1 && rect.bottom <= listRect.bottom + 1};
            });
            return {scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollWidth: scroller.scrollWidth, clientWidth: scroller.clientWidth, listTop: listRect.top, listBottom: listRect.bottom, lastRow: {name: lastRow.querySelector('.member-identity strong')?.textContent?.trim(), top: rowRect.top, bottom: rowRect.bottom}, paddingBottom, alignmentAdjustment, actions: actions.map(rect => ({left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom})), rowLeft: rowRect.left, rowRight: rowRect.right, visibleRows};
          });
          expect(adminEndMetrics.scrollTop).toBeGreaterThan(0);
          expect(adminEndMetrics.alignmentAdjustment).toBeLessThanOrEqual(adminEndMetrics.paddingBottom + 1);
          expect(adminEndMetrics.scrollHeight - (adminEndMetrics.scrollTop + adminEndMetrics.clientHeight)).toBeLessThanOrEqual(adminEndMetrics.paddingBottom + 1);
          expect(adminEndMetrics.scrollWidth).toBeLessThanOrEqual(adminEndMetrics.clientWidth + 1);
          expect(adminEndMetrics.lastRow.top).toBeGreaterThanOrEqual(adminEndMetrics.listTop - 1);
          expect(adminEndMetrics.lastRow.bottom).toBeLessThanOrEqual(adminEndMetrics.listBottom - 1);
          expect(adminEndMetrics.visibleRows.some(row => row.name === adminEndMetrics.lastRow.name && row.fullyVisible)).toBeTruthy();
          expect(adminEndMetrics.actions.every(action => action.left >= adminEndMetrics.rowLeft - 1 && action.right <= adminEndMetrics.rowRight + 1 && action.top >= adminEndMetrics.lastRow.top - 1 && action.bottom <= adminEndMetrics.lastRow.bottom + 1)).toBeTruthy();
          expect(adminEndMetrics.visibleRows.every(row => row.fullyVisible), `${theme}/${viewport.width}px admin list should rest on complete rows: ${JSON.stringify(adminEndMetrics)}`).toBeTruthy();
          await groupAdmin.screenshot({path: testInfo.outputPath(`group-settings-admin-${theme}-${viewport.width}-members-end.png`), fullPage: false});
        }
      }
    } finally {
      await adminContext.close();
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
    await owner.evaluate(() => window.localStorage.removeItem('zwei_selected_conversation'));
    await owner.reload();
    await waitForLiveConnection(owner);
    const ownerGroup = owner.locator('.person-option').filter({hasText: 'Browser acceptance group renamed'});
    await expect(ownerGroup).toBeVisible();
    await ownerGroup.click();
    await expect(owner.locator('.chat-header h2')).toHaveText('Browser acceptance group renamed');
    await expect(owner.getByText('Owner made Member 1 a member.', {exact: true})).toBeVisible();
    await setTheme(owner, 'dark');
    const manageGroup = owner.getByRole('button', {name: 'Manage group'});
    if (!(await owner.locator('.group-manager').isVisible())) await manageGroup.click();
    await expect(owner.locator('.group-manager')).toBeVisible();
    await expect(owner.locator('.group-manager .group-members > li').filter({has: owner.locator('strong').filter({hasText: /^Member 1$/})}).locator('.member-identity small')).toHaveText('member');
    const groupSettingsPanel = owner.locator('.group-manager .group-settings-panel');
    const deleteButton = groupSettingsPanel.getByRole('button', {name: 'Delete group'});
    await expect(deleteButton).toBeVisible();
    await deleteButton.scrollIntoViewIfNeeded();
    await expect(owner.locator('.group-manager')).toBeVisible();
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeInViewport();
    await owner.once('dialog', dialog => dialog.accept());
    const deleteResponse = owner.waitForResponse(response => response.url().endsWith(`/api/chat/groups/${groupID}`) && response.request().method() === 'DELETE');
    await deleteButton.click();
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
      await expect(page.getByRole('button', {name: 'Join or start group audio call'})).toBeVisible();
    }));

    await owner.getByRole('button', {name: 'Join or start group audio call'}).click();
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

test('hands a three-person group call from A to B to C and lets C leave and rejoin B', async ({browser}, testInfo) => {
  test.setTimeout(150_000);
  const participants = [
    {name: 'A', email: uniqueEmail('handoff-a'), viewport: {width: 1440, height: 900}, color: '#b84a3a'},
    {name: 'B', email: uniqueEmail('handoff-b'), viewport: {width: 1440, height: 900}, color: '#2563eb'},
    {name: 'C', email: uniqueEmail('handoff-c'), viewport: {width: 390, height: 844}, color: '#15803d'},
  ];
  const contexts = await Promise.all(participants.map(({viewport}) => browser.newContext({viewport})));
  const [a, b, c] = await Promise.all(contexts.map(context => context.newPage()));

  try {
    for (const [index, {email, name, color}] of participants.entries()) {
      await installDeterministicGroupMedia([a, b, c][index], color);
      await register([a, b, c][index], email, `Person ${name}`);
    }
    await Promise.all([a, b, c].map(waitForLiveConnection));
    const token = await authenticatedToken(contexts[0], participants[0].email, 'handoff-a');
    const memberIDs = await Promise.all(participants.slice(1).map(participant => userID(contexts[0], token, participant.email)));
    const directConversation = await contexts[0].request.post(`${chatBase}/api/chat/conversations`, {
      headers: {Authorization: `${token.token_type} ${token.access_token}`},
      data: {other_user_id: memberIDs[1]},
    });
    expect([200, 201]).toContain(directConversation.status());
    const created = await contexts[0].request.post(`${chatBase}/api/chat/groups`, {
      headers: {Authorization: `${token.token_type} ${token.access_token}`},
      data: {name: 'Three-person handoff', member_ids: memberIDs},
    });
    expect(created.status()).toBe(201);
    const handoffGroupID = (await created.json() as {id: string}).id;
    for (const page of [a, b, c]) {
      await page.reload();
      await waitForLiveConnection(page);
      const group = page.locator('.person-option').filter({hasText: 'Three-person handoff'});
      await expect(group).toBeVisible({timeout: 10_000});
      await group.click();
      await expect(page.getByRole('button', {name: 'Join or start group audio call'})).toBeEnabled();
    }
    await setTheme(a, 'light');
    await setTheme(b, 'dark');
    await setTheme(c, 'light');

    // A calls. Both B and C receive their own Join action before either joins.
    await a.getByRole('button', {name: 'Join or start group audio call'}).click();
    await Promise.all([b, c].map(page => expect(page.getByRole('button', {name: 'Join call'})).toBeVisible({timeout: 10_000})));
    await c.screenshot({path: testInfo.outputPath('handoff-a-incoming-c-light-390.png'), fullPage: false});
    await b.getByRole('button', {name: 'Join call'}).click();
    await c.getByRole('button', {name: 'Join call'}).click();
    await Promise.all([a, b, c].map(page => expect(page.locator('.group-call-panel')).toContainText('3 participants in the group call.', {timeout: 10_000})));
    await Promise.all([a, b, c].map(assertGroupCallAudioConnected));
    await a.waitForTimeout(2_000);
    await a.getByRole('button', {name: 'End group call for everyone'}).click();
    await Promise.all([a, b, c].map(page => expect(page.locator('.group-call-terminal')).toHaveText('Group call ended.', {timeout: 10_000})));
    const firstEndPresentation = await Promise.all([a, b, c].map(page => page.evaluate(() => {
      const host = document.querySelector('app-home');
      const component = host && window.ng ? window.ng.getComponent(host) as {
        selectedConversation?: {id?: string};
        groupCall?: {state?: {phase?: string; conversationID?: string; room?: {conversation_id?: string}}};
      } : undefined;
      return {
        selectedConversationID: component?.selectedConversation?.id,
        callPhase: component?.groupCall?.state?.phase,
        callOrigin: component?.groupCall?.state?.conversationID,
        roomConversationID: component?.groupCall?.state?.room?.conversation_id,
        terminalNotice: document.querySelector('.group-call-terminal')?.textContent?.trim(),
      };
    })));
    expect(firstEndPresentation.map(state => state.selectedConversationID)).toEqual([handoffGroupID, handoffGroupID, handoffGroupID]);
    expect(firstEndPresentation.map(state => state.terminalNotice)).toEqual(['Group call ended.', 'Group call ended.', 'Group call ended.']);

    // B calls. C leaves while A and B remain connected, then uses the primary
    // discover/join action rather than starting a competing room.
    await b.getByRole('button', {name: 'Join or start group audio call'}).click();
    await Promise.all([a, c].map(page => expect(page.getByRole('button', {name: 'Join call'})).toBeVisible({timeout: 10_000})));
    await a.getByRole('button', {name: 'Join call'}).click();
    await c.getByRole('button', {name: 'Join call'}).click();
    await Promise.all([a, b, c].map(page => expect(page.locator('.group-call-panel')).toContainText('3 participants in the group call.', {timeout: 10_000})));
    await c.getByRole('button', {name: 'Leave call'}).click();
    await expect(c.locator('.group-call-panel')).toHaveCount(0);
    await expect(c.locator('.group-call-terminal')).toContainText('You left the group call.');
    await c.screenshot({path: testInfo.outputPath('handoff-c-left-origin-group-390.png'), fullPage: false});
    await c.getByRole('button', {name: 'Back to chats'}).click();
    await c.locator('.person-option').filter({hasText: 'Person A'}).click();
    await expect(c.locator('.group-call-terminal')).toHaveCount(0);
    await expect(c.locator('.message-history')).toBeVisible();
    await c.screenshot({path: testInfo.outputPath('handoff-c-left-unrelated-direct-390.png'), fullPage: false});
    await c.getByRole('button', {name: 'Back to chats'}).click();
    await c.locator('.person-option').filter({hasText: 'Three-person handoff'}).click();
    await expect(c.locator('.group-call-terminal')).toHaveText(/You left the group call\.|Group call ended\./);
    await Promise.all([a, b].map(page => expect(page.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000})));
    await expect(c.locator('.group-call-panel')).toHaveCount(0);
    await expect(c.locator('.message-history')).toBeVisible();
    await expect(c.locator('audio[groupRemoteAudio]')).toHaveCount(0);
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(c, theme);
      const primaryCall = c.getByRole('button', {name: 'Join or start group audio call'});
      await expect(primaryCall).toBeVisible();
      await expect(primaryCall).toBeEnabled();
      const rect = await primaryCall.boundingBox();
      expect(rect?.x).toBeGreaterThanOrEqual(0);
      expect((rect?.x ?? 390) + (rect?.width ?? 390)).toBeLessThanOrEqual(390);
      await c.screenshot({path: testInfo.outputPath(`handoff-b-c-left-${theme}-390.png`), fullPage: false});
    }
    await c.evaluate(() => { (window as Window & {__denyGroupMicrophone: boolean}).__denyGroupMicrophone = true; });
    await c.getByRole('button', {name: 'Join or start group audio call'}).click();
    await expect(c.locator('.group-call-terminal')).toContainText('Microphone permission was denied.');
    await expect(c.getByRole('button', {name: 'Join or start group audio call'})).toBeVisible();
    await expect(c.getByRole('button', {name: 'Join or start group audio call'})).toBeEnabled();
    await expect(c.locator('.group-call-panel')).toHaveCount(0);
    expect(await c.evaluate(() => window.innerWidth)).toBe(390);
    await c.screenshot({path: testInfo.outputPath('handoff-b-c-rejoin-permission-denied-light-390.png'), fullPage: false});
    console.log(`HANDOFF_REJOIN_FAILURE_SCREENSHOT ${testInfo.outputPath('handoff-b-c-rejoin-permission-denied-light-390.png')}`);
    await c.evaluate(() => { (window as Window & {__denyGroupMicrophone: boolean}).__denyGroupMicrophone = false; });
    await c.getByRole('button', {name: 'Join or start group audio call'}).click();
    await Promise.all([a, b, c].map(page => expect(page.locator('.group-call-panel')).toContainText('3 participants in the group call.', {timeout: 10_000})));
    await assertGroupCallAudioConnected(c);
    await c.screenshot({path: testInfo.outputPath('handoff-b-c-rejoined-dark-390.png'), fullPage: false});
    await c.getByRole('button', {name: 'Back to chats'}).click();
    await c.locator('.person-option').filter({hasText: 'Person A'}).click();
    await b.getByRole('button', {name: 'End group call for everyone'}).click();
    await Promise.all([a, b].map(page => expect(page.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 10_000})));
    await expect(c.locator('.group-call-terminal')).toHaveCount(0);
    await c.getByRole('button', {name: 'Back to chats'}).click();
    await c.locator('.person-option').filter({hasText: 'Three-person handoff'}).click();
    await expect(c.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 5_000});
    await c.screenshot({path: testInfo.outputPath('handoff-c-ended-origin-group-390.png'), fullPage: false});
    await c.getByRole('button', {name: 'Back to chats'}).click();
    await c.locator('.person-option').filter({hasText: 'Person A'}).click();
    await expect(c.locator('.group-call-terminal')).toHaveCount(0);
    await c.screenshot({path: testInfo.outputPath('handoff-c-ended-unrelated-direct-390.png'), fullPage: false});
    await c.getByRole('button', {name: 'Back to chats'}).click();
    await c.locator('.person-option').filter({hasText: 'Three-person handoff'}).click();

    // C starts the next room; both former participants receive Join and connect.
    await c.getByRole('button', {name: 'Join or start group audio call'}).click();
    await Promise.all([a, b].map(page => expect(page.getByRole('button', {name: 'Join call'})).toBeVisible({timeout: 10_000})));
    await a.getByRole('button', {name: 'Join call'}).click();
    await b.getByRole('button', {name: 'Join call'}).click();
    await Promise.all([a, b, c].map(page => expect(page.locator('.group-call-panel')).toContainText('3 participants in the group call.', {timeout: 10_000})));
    await Promise.all([a, b, c].map(assertGroupCallAudioConnected));
    await c.screenshot({path: testInfo.outputPath('handoff-c-active-dark-390.png'), fullPage: false});
    await c.getByRole('button', {name: 'End group call for everyone'}).click();
    await Promise.all([a, b, c].map(page => expect(page.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 10_000})));
    for (const page of [a, b, c]) await expect(page.getByText('Group call unavailable: user is already in a call')).toHaveCount(0);
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
  }
});

test('runs a deterministic three-member group media lifecycle', async ({browser}, testInfo) => {
  test.setTimeout(240_000);
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
      const startGroupCall = page.getByRole('button', {name: 'Join or start group audio call'});
      await expect(startGroupCall).toBeVisible();
      await expect(startGroupCall).toBeEnabled({timeout: 10_000});
    }

    await assertGroupPresenceContrast(owner, testInfo, 'light');
    await assertGroupPresenceContrast(owner, testInfo, 'dark');

    await owner.getByRole('button', {name: 'Join or start group audio call'}).click();
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
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
        await owner.setViewportSize(viewport);
        await setTheme(owner, theme);
        const presentationQuality = owner.getByRole('combobox', {name: 'Presentation quality'});
        const shareAudio = owner.getByRole('checkbox', {name: 'Share audio'});
        await expect(presentationQuality).toBeVisible();
        await expect(shareAudio).toBeVisible();
        await expect(shareAudio).not.toBeChecked();
        await expect(owner.locator('.share-audio-label')).toHaveText('Share audio');
        const uncheckedSurface = await owner.locator('.share-audio-toggle').evaluate(element => ({background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderColor}));
        await shareAudio.check();
        await expect(shareAudio).toBeChecked();
        const checkedSurface = await owner.locator('.share-audio-toggle').evaluate(element => ({background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderColor}));
        expect(checkedSurface).not.toEqual(uncheckedSurface);
        await shareAudio.focus();
        const checkedFocusGeometry = await measureShareAudioFocusClip(owner.locator('.share-audio-toggle'));
        console.info(`GROUP_SHARE_AUDIO_CHECKED_FOCUS ${JSON.stringify({theme, viewport, checkedFocusGeometry})}`);
        expect(checkedFocusGeometry.ring.left, `${theme}/${viewport.width}px checked focus ring clips left: ${JSON.stringify(checkedFocusGeometry)}`).toBeGreaterThanOrEqual(checkedFocusGeometry.clip.left - 1);
        expect(checkedFocusGeometry.ring.right, `${theme}/${viewport.width}px checked focus ring clips right: ${JSON.stringify(checkedFocusGeometry)}`).toBeLessThanOrEqual(checkedFocusGeometry.clip.right + 1);
        expect(checkedFocusGeometry.ring.top, `${theme}/${viewport.width}px checked focus ring clips top: ${JSON.stringify(checkedFocusGeometry)}`).toBeGreaterThanOrEqual(checkedFocusGeometry.clip.top - 1);
        expect(checkedFocusGeometry.ring.bottom, `${theme}/${viewport.width}px checked focus ring clips bottom: ${JSON.stringify(checkedFocusGeometry)}`).toBeLessThanOrEqual(checkedFocusGeometry.clip.bottom + 1);
        await owner.screenshot({path: testInfo.outputPath(`group-call-share-audio-checked-focus-${theme}-${viewport.width}.png`), fullPage: false});
        await shareAudio.uncheck();
        await expect(shareAudio).not.toBeChecked();
        const deviceRowWidths = await measureCallDeviceRowAlignment(owner.locator('.group-call-devices .call-presentation-devices'));
        console.info(`GROUP_CALL_DEVICE_ROW_WIDTHS ${JSON.stringify({theme, viewport, deviceRowWidths})}`);
        expect(Math.abs((deviceRowWidths.deviceRowSpan?.width ?? 0) - (deviceRowWidths.qualityAudioControls?.width ?? 0)), `${theme}/${viewport.width}px group device rows must have matching spans: ${JSON.stringify(deviceRowWidths)}`).toBeLessThanOrEqual(1);
        await shareAudio.blur();
        await shareAudio.hover();
        const hoverOutline = await owner.locator('.share-audio-toggle').evaluate(element => getComputedStyle(element).outlineStyle);
        expect(hoverOutline, `${theme}/${viewport.width}px Share audio hover must not show a keyboard ring`).toBe('none');
        await shareAudio.focus();
        await expect(shareAudio).toBeFocused();
        const shareAudioFocusStyle = await owner.locator('.share-audio-toggle').evaluate(element => {
          const checkbox = element.querySelector<HTMLInputElement>('input');
          const wrapper = element.getBoundingClientRect();
          const content = element.closest<HTMLElement>('.group-call-content')?.getBoundingClientRect();
          const style = getComputedStyle(element);
          const ringInset = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
          return {
            outline: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            checkboxOutline: checkbox ? getComputedStyle(checkbox).outlineStyle : 'missing',
            ring: {left: wrapper.left - ringInset, right: wrapper.right + ringInset, top: wrapper.top - ringInset, bottom: wrapper.bottom + ringInset},
            content: content && {left: content.left, right: content.right, top: content.top, bottom: content.bottom},
          };
        });
        expect(shareAudioFocusStyle.outline).not.toBe('none');
        expect(shareAudioFocusStyle.outlineWidth).toBe('3px');
        expect(shareAudioFocusStyle.checkboxOutline).toBe('none');
        expect(shareAudioFocusStyle.content).toBeDefined();
        expect(shareAudioFocusStyle.ring.left).toBeGreaterThanOrEqual((shareAudioFocusStyle.content?.left ?? 0) - 1);
        expect(shareAudioFocusStyle.ring.right).toBeLessThanOrEqual((shareAudioFocusStyle.content?.right ?? 0) + 1);
        expect(shareAudioFocusStyle.ring.top).toBeGreaterThanOrEqual((shareAudioFocusStyle.content?.top ?? 0) - 1);
        expect(shareAudioFocusStyle.ring.bottom).toBeLessThanOrEqual((shareAudioFocusStyle.content?.bottom ?? 0) + 1);
        const uncheckedFocusGeometry = await measureShareAudioFocusClip(owner.locator('.share-audio-toggle'));
        expect(uncheckedFocusGeometry.ring.left, `${theme}/${viewport.width}px unchecked focus ring clips left: ${JSON.stringify(uncheckedFocusGeometry)}`).toBeGreaterThanOrEqual(uncheckedFocusGeometry.clip.left - 1);
        expect(uncheckedFocusGeometry.ring.right, `${theme}/${viewport.width}px unchecked focus ring clips right: ${JSON.stringify(uncheckedFocusGeometry)}`).toBeLessThanOrEqual(uncheckedFocusGeometry.clip.right + 1);
        expect(uncheckedFocusGeometry.ring.top, `${theme}/${viewport.width}px unchecked focus ring clips top: ${JSON.stringify(uncheckedFocusGeometry)}`).toBeGreaterThanOrEqual(uncheckedFocusGeometry.clip.top - 1);
        expect(uncheckedFocusGeometry.ring.bottom, `${theme}/${viewport.width}px unchecked focus ring clips bottom: ${JSON.stringify(uncheckedFocusGeometry)}`).toBeLessThanOrEqual(uncheckedFocusGeometry.clip.bottom + 1);
        await owner.screenshot({path: testInfo.outputPath(`group-call-share-audio-focus-${theme}-${viewport.width}.png`), fullPage: false});
        await presentationQuality.click();
        const qualityList = owner.getByRole('listbox', {name: 'Presentation quality options'});
        await expect(qualityList).toBeVisible();
        const pickerGeometry = await owner.evaluate(() => {
          const picker = document.querySelector<HTMLElement>('.call-quality-listbox')?.getBoundingClientRect();
          const actions = document.querySelector<HTMLElement>('.group-call-actions')?.getBoundingClientRect();
          const trigger = document.querySelector<HTMLElement>('.group-call-devices .call-quality-trigger')?.getBoundingClientRect();
          const intersects = (first: DOMRect, second: DOMRect) => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
          const overlappingControls = Array.from(document.querySelectorAll<HTMLElement>('.group-call-devices .call-control:not(.call-quality-control) > span, .group-call-devices .call-control:not(.call-quality-control) [role="combobox"]'))
            .map(element => ({label: element.getAttribute('aria-label') || element.textContent?.trim() || '', rect: element.getBoundingClientRect()}))
            .filter(control => control.rect.width > 0 && control.rect.height > 0 && picker && intersects(control.rect, picker));
          const audioLabel = document.querySelector<HTMLElement>('.share-audio-label')?.getBoundingClientRect();
          const audioLabelOverlaps = Boolean(audioLabel && picker && audioLabel.width > 0 && intersects(audioLabel, picker));
          return {left: picker?.left ?? -1, right: picker?.right ?? Infinity, top: picker?.top ?? -1, bottom: picker?.bottom ?? Infinity, triggerBottom: trigger?.bottom ?? Infinity, actionsTop: actions?.top ?? 0, overlappingControls: overlappingControls.map(control => control.label), audioLabelOverlaps};
        });
        expect(pickerGeometry.left).toBeGreaterThanOrEqual(0);
        expect(pickerGeometry.right, `${theme}/${viewport.width}px quality picker exceeds viewport`).toBeLessThanOrEqual(viewport.width + 1);
        expect(pickerGeometry.top, `${theme}/${viewport.width}px quality picker should open below its trigger`).toBeGreaterThanOrEqual(pickerGeometry.triggerBottom - 1);
        expect(pickerGeometry.bottom, `${theme}/${viewport.width}px quality picker overlaps the actions: ${JSON.stringify(pickerGeometry)}`).toBeLessThanOrEqual(pickerGeometry.actionsTop);
        expect(pickerGeometry.overlappingControls, `${theme}/${viewport.width}px quality picker overlaps microphone/speaker controls`).toEqual([]);
        expect(pickerGeometry.audioLabelOverlaps, `${theme}/${viewport.width}px quality picker obscures the Share audio label`).toBeFalsy();
        await owner.screenshot({path: testInfo.outputPath(`group-call-quality-open-${theme}-${viewport.width}.png`), fullPage: false});
        await owner.keyboard.press('Escape');
        await expect(qualityList).toHaveCount(0);
      }
    }
    await owner.setViewportSize({width: 1440, height: 900});
    await setTheme(owner, 'dark');
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
    await expect(member.getByRole('checkbox', {name: 'Share audio'})).toBeDisabled();
    await expect(owner.locator('.group-presentation')).toBeVisible({timeout: 10_000});
    await expect.poll(async () => owner.locator('.group-presentation').evaluate(video => {
      const presentation = video as HTMLVideoElement;
      const track = presentation.srcObject?.getVideoTracks()[0];
      let brightness = 0;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext('2d');
        if (context && presentation.videoWidth > 0 && presentation.videoHeight > 0) {
          context.drawImage(presentation, presentation.videoWidth / 2, presentation.videoHeight / 2, 1, 1, 0, 0, 1, 1);
          const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
          brightness = red + green + blue;
        }
      } catch { /* Wait for a rendered, non-background frame. */ }
      return presentation.srcObject?.active === true && track?.kind === 'video' && track.readyState === 'live' && brightness > 80;
    }), {timeout: 10_000}).toBeTruthy();
    await owner.screenshot({path: testInfo.outputPath('group-call-remote-presentation-dark.png'), fullPage: false, timeout: 15_000});
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
        await assertGroupPresentationLayout(owner, testInfo, theme, viewport);
      }
    }
    for (const theme of ['dark', 'light'] as const) {
      for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
        await owner.setViewportSize(viewport);
        await setTheme(owner, theme);
        const fullscreenButton = owner.getByRole('button', {name: 'Expand shared presentation'});
        await expect(fullscreenButton).toBeVisible();
        if (viewport.width === 1440 && theme === 'dark') {
          await fullscreenButton.focus();
          await owner.keyboard.press('Tab');
          await owner.keyboard.press('Shift+Tab');
          await expect(fullscreenButton).toBeFocused();
          const focusStyle = await fullscreenButton.evaluate(button => ({outline: getComputedStyle(button).outlineStyle, width: getComputedStyle(button).outlineWidth}));
          expect(focusStyle.outline).toBe('solid');
          expect(focusStyle.width).toBe('3px');
        }
        await fullscreenButton.click();
        await expect(owner.getByRole('button', {name: 'Exit fullscreen'})).toBeVisible();
        const fullscreenMetrics = await owner.locator('.group-call-presentation').evaluate(stage => {
          const video = stage.querySelector('video');
          const heading = stage.querySelector<HTMLElement>('.group-call-presentation-heading');
          const control = stage.querySelector<HTMLElement>('.group-presentation-fullscreen');
          const stageRect = stage.getBoundingClientRect();
          const videoRect = video?.getBoundingClientRect();
          return {isFullscreen: document.fullscreenElement === stage, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight, stage: {left: stageRect.left, right: stageRect.right, top: stageRect.top, bottom: stageRect.bottom, width: stageRect.width, height: stageRect.height}, video: videoRect && {left: videoRect.left, right: videoRect.right, top: videoRect.top, bottom: videoRect.bottom}, headingVisible: !!heading && getComputedStyle(heading).visibility === 'visible' && heading.getBoundingClientRect().height > 0, controlVisible: !!control && getComputedStyle(control).visibility === 'visible' && control.getBoundingClientRect().width > 0};
        });
        expect(fullscreenMetrics.isFullscreen, `${theme}/${viewport.width}px actual fullscreen state`).toBe(true);
        expect(fullscreenMetrics.documentWidth).toBeLessThanOrEqual(fullscreenMetrics.viewportWidth + 1);
        expect(fullscreenMetrics.stage.left).toBe(0);
        expect(fullscreenMetrics.stage.top).toBe(0);
        expect(fullscreenMetrics.stage.width).toBeGreaterThanOrEqual(viewport.width - 1);
        expect(fullscreenMetrics.stage.height).toBeGreaterThanOrEqual(viewport.height - 1);
        expect(fullscreenMetrics.video?.left).toBeGreaterThanOrEqual(fullscreenMetrics.stage.left - 1);
        expect(fullscreenMetrics.video?.right).toBeLessThanOrEqual(fullscreenMetrics.stage.right + 1);
        expect(fullscreenMetrics.video?.top).toBeGreaterThanOrEqual(fullscreenMetrics.stage.top - 1);
        expect(fullscreenMetrics.video?.bottom).toBeLessThanOrEqual(fullscreenMetrics.stage.bottom + 1);
        expect(fullscreenMetrics.headingVisible && fullscreenMetrics.controlVisible, `${theme}/${viewport.width}px visible fullscreen toolbar`).toBe(true);
        await owner.screenshot({path: testInfo.outputPath(`group-call-presentation-fullscreen-${theme}-${viewport.width}.png`), fullPage: false, timeout: 15_000});
        if ((viewport.width + (theme === 'light' ? 1 : 0)) % 2 === 0) {
          await owner.getByRole('button', {name: 'Exit fullscreen'}).click();
        } else {
          await owner.keyboard.press('Escape');
        }
        await expect.poll(() => owner.evaluate(() => document.fullscreenElement === null)).toBe(true);
        await expect(owner.getByRole('button', {name: 'Expand shared presentation'})).toBeVisible();
      }
    }
    await owner.setViewportSize({width: 1440, height: 900});
    await setTheme(owner, 'dark');

    const assertRemotePresentationFrame = async (label: string): Promise<void> => {
      await expect(owner.locator('.group-presentation')).toBeVisible({timeout: 10_000});
      await expect.poll(async () => owner.locator('.group-presentation').evaluate(video => {
        const presentation = video as HTMLVideoElement;
        const track = presentation.srcObject?.getVideoTracks()[0];
        let frameBrightness = 0;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 1;
          canvas.height = 1;
          const context = canvas.getContext('2d');
          if (context && presentation.videoWidth > 0 && presentation.videoHeight > 0) {
            context.drawImage(presentation, presentation.videoWidth / 2, presentation.videoHeight / 2, 1, 1, 0, 0, 1, 1);
            const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
            frameBrightness = red + green + blue;
          }
        } catch { /* Wait for the browser's next received frame. */ }
        const rect = presentation.getBoundingClientRect();
        return presentation.srcObject?.active === true && track?.kind === 'video' && track.readyState === 'live'
          && rect.width > 0 && rect.height > 0 && getComputedStyle(presentation).visibility === 'visible' && frameBrightness > 80;
      }), {timeout: 20_000}).toBeTruthy();
      await owner.screenshot({path: testInfo.outputPath(`${label}.png`), fullPage: false, timeout: 15_000});
    };
    await owner.getByRole('button', {name: 'Expand shared presentation'}).click();
    await expect.poll(() => owner.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await member.getByRole('button', {name: 'Stop presenting'}).click();
    await expect(owner.locator('.group-call-presentation')).toHaveCount(0);
    await expect.poll(() => owner.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await expect(member.getByRole('button', {name: 'Present screen'})).toBeVisible();
    await member.getByRole('button', {name: 'Present screen'}).click();
    await expect(member.getByRole('button', {name: 'Stop presenting'})).toBeVisible();
    await assertRemotePresentationFrame('group-call-remote-presentation-restarted-dark');
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
        await assertGroupPresentationLayout(owner, testInfo, theme, viewport);
        const restartedVideo = await owner.locator('.group-presentation').evaluate(video => {
          const presentation = video as HTMLVideoElement;
          const track = presentation.srcObject?.getVideoTracks()[0];
          let brightness = 0;
          try {
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            const context = canvas.getContext('2d');
            if (context && presentation.videoWidth > 0 && presentation.videoHeight > 0) {
              context.drawImage(presentation, presentation.videoWidth / 2, presentation.videoHeight / 2, 1, 1, 0, 0, 1, 1);
              const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
              brightness = red + green + blue;
            }
          } catch { /* A frame is not readable until the restarted track renders. */ }
          const rect = presentation.getBoundingClientRect();
          return {live: presentation.srcObject?.active === true && track?.readyState === 'live' && brightness > 80, width: rect.width, height: rect.height};
        });
        expect(restartedVideo.live, `${theme}/${viewport.width}px restarted group share must render a live non-background frame`).toBe(true);
        expect(restartedVideo.width).toBeGreaterThan(0);
        expect(restartedVideo.height).toBeGreaterThan(0);
        await owner.screenshot({path: testInfo.outputPath(`group-call-presentation-restarted-${theme}-${viewport.width}.png`), fullPage: false, timeout: 15_000});
      }
    }
    await owner.setViewportSize({width: 1440, height: 900});
    await setTheme(owner, 'dark');

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
    // Tooltip acceptance matrix: late-join/live presentation × light/dark × desktop (1440), medium (1024), mobile (390).
    // Measure the rendered tooltip against the full quality row, action controls, and Leave button.
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [{width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
        await observer.setViewportSize(viewport);
        await setTheme(observer, theme);
        const endCall = observer.getByRole('button', {name: 'End group call for everyone'});
        await endCall.hover();
        const endCallTooltip = observer.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface').filter({hasText: 'End group call for everyone'}).last();
        await expect(endCallTooltip).toBeVisible();
         await waitForReadableTooltip(endCallTooltip);
        const tooltipGeometry = await observer.evaluate(() => {
          const tooltip = document.querySelector<HTMLElement>('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface');
          const bounds = (selector: string) => {
            const rect = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
            return rect && {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom};
          };
          const tooltipRect = tooltip?.getBoundingClientRect();
          const intersects = (first: NonNullable<typeof tooltipRect>, second: {left: number; right: number; top: number; bottom: number} | undefined) => Boolean(second && first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top);
          const quality = bounds('.group-call-devices .call-quality-control');
          const actions = bounds('.group-call-active-controls');
          const leave = bounds('.group-call-leave');
          return {
            tooltip: tooltipRect && {left: tooltipRect.left, right: tooltipRect.right, top: tooltipRect.top, bottom: tooltipRect.bottom},
            quality,
            actions,
            leave,
            intersectsQuality: Boolean(tooltipRect && intersects(tooltipRect, quality)),
            intersectsActions: Boolean(tooltipRect && intersects(tooltipRect, actions)),
            intersectsLeave: Boolean(tooltipRect && intersects(tooltipRect, leave)),
            viewport: {width: window.innerWidth, height: window.innerHeight},
          };
        });
        console.info(`GROUP_LATE_JOIN_TOOLTIP_GEOMETRY ${JSON.stringify({theme, viewport, tooltipGeometry})}`);
        expect(tooltipGeometry.tooltip, `${theme}/${viewport.width}px end-call tooltip must render`).toBeDefined();
        expect(tooltipGeometry.tooltip?.left, `${theme}/${viewport.width}px tooltip exceeds left viewport edge: ${JSON.stringify(tooltipGeometry)}`).toBeGreaterThanOrEqual(0);
        expect(tooltipGeometry.tooltip?.right, `${theme}/${viewport.width}px tooltip exceeds right viewport edge: ${JSON.stringify(tooltipGeometry)}`).toBeLessThanOrEqual(viewport.width + 1);
        expect(tooltipGeometry.tooltip?.top, `${theme}/${viewport.width}px tooltip exceeds top viewport edge: ${JSON.stringify(tooltipGeometry)}`).toBeGreaterThanOrEqual(0);
        expect(tooltipGeometry.tooltip?.bottom, `${theme}/${viewport.width}px tooltip exceeds bottom viewport edge: ${JSON.stringify(tooltipGeometry)}`).toBeLessThanOrEqual(viewport.height + 1);
        expect(tooltipGeometry.intersectsQuality, `${theme}/${viewport.width}px tooltip overlaps presentation quality selector: ${JSON.stringify(tooltipGeometry)}`).toBeFalsy();
        expect(tooltipGeometry.intersectsActions, `${theme}/${viewport.width}px tooltip overlaps group action row: ${JSON.stringify(tooltipGeometry)}`).toBeFalsy();
        expect(tooltipGeometry.intersectsLeave, `${theme}/${viewport.width}px tooltip overlaps Leave call: ${JSON.stringify(tooltipGeometry)}`).toBeFalsy();
        await observer.screenshot({path: testInfo.outputPath(`group-call-late-join-tooltip-${theme}-${viewport.width}.png`), fullPage: false, timeout: 15_000});
      }
    }

    await member.getByRole('button', {name: 'Leave call'}).click();
    await expect(owner.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000});
    await expect(observer.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000});
    await expect(member.locator('.group-call-terminal')).toContainText('You left the group call.');
    await expect(owner.locator('.group-presentation')).toBeHidden({timeout: 10_000});
    await expect(observer.locator('.group-presentation')).toBeHidden({timeout: 10_000});
    await expect(owner.locator('audio[groupRemoteAudio]')).toHaveCount(1);
    await owner.getByRole('button', {name: 'Minimize group call'}).click();
    const minimizedGroupCall = owner.locator('.group-call-minimized');
    const minimizedEndCall = owner.getByRole('button', {name: 'End group call for everyone'});
    await expect(minimizedGroupCall).toBeVisible();
    await expect(minimizedEndCall).toHaveText('End group call');
    await expect(owner.locator('audio[groupRemoteAudio]')).toHaveCount(0);
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of [{width: 2560, height: 1440}, {width: 1440, height: 900}, {width: 1024, height: 900}, {width: 390, height: 844}]) {
        await owner.setViewportSize(viewport);
        await setTheme(owner, theme);
        const bounds = await minimizedGroupCall.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const restore = element.querySelector<HTMLElement>('.call-minimized-summary')?.getBoundingClientRect();
          const end = element.querySelector<HTMLElement>('.call-minimized-end')?.getBoundingClientRect();
          return {rect: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}, restore: restore && {left: restore.left, right: restore.right, top: restore.top, bottom: restore.bottom}, end: end && {left: end.left, right: end.right, top: end.top, bottom: end.bottom}, documentScrollWidth: document.documentElement.scrollWidth, documentClientWidth: document.documentElement.clientWidth, viewportHeight: window.innerHeight};
        });
        expect(bounds.documentScrollWidth).toBeLessThanOrEqual(bounds.documentClientWidth + 1);
        expect(bounds.rect.left).toBeGreaterThanOrEqual(0);
        expect(bounds.rect.right).toBeLessThanOrEqual(viewport.width);
        expect(bounds.rect.top).toBeGreaterThanOrEqual(0);
        expect(bounds.rect.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
        for (const control of [bounds.restore, bounds.end]) {
          expect(control).toBeDefined();
          expect(control?.left).toBeGreaterThanOrEqual(bounds.rect.left - 1);
          expect(control?.right).toBeLessThanOrEqual(bounds.rect.right + 1);
          expect(control?.top).toBeGreaterThanOrEqual(bounds.rect.top - 1);
          expect(control?.bottom).toBeLessThanOrEqual(bounds.rect.bottom + 1);
        }
        const endContrast = await measureRenderedTextContrast(minimizedEndCall);
        expect(endContrast.ratio, `${theme}/${viewport.width}px minimized end label contrast: ${JSON.stringify(endContrast)}`).toBeGreaterThanOrEqual(4.5);
        await minimizedEndCall.hover();
        const minimizedEndTooltip = owner.locator('.mat-mdc-tooltip-panel .mat-mdc-tooltip-surface').filter({hasText: 'End group call for everyone'}).last();
        await expect(minimizedEndTooltip).toBeVisible();
         const minimizedEndTooltipContrast = await waitForReadableTooltip(minimizedEndTooltip);
        expect(minimizedEndTooltipContrast.ratio, `${theme}/${viewport.width}px minimized End tooltip contrast: ${JSON.stringify(minimizedEndTooltipContrast)}`).toBeGreaterThanOrEqual(4.5);
        await expect(minimizedEndTooltip).toHaveCSS('background-color', 'rgb(241, 245, 249)');
        await expect(minimizedEndTooltip).toHaveCSS('color', 'rgb(23, 32, 51)');
        const minimizedTooltipBounds = await minimizedEndTooltip.boundingBox();
        expect(minimizedTooltipBounds?.x).toBeGreaterThanOrEqual(0);
        expect(minimizedTooltipBounds?.y).toBeGreaterThanOrEqual(0);
        expect((minimizedTooltipBounds?.x ?? viewport.width) + (minimizedTooltipBounds?.width ?? viewport.width)).toBeLessThanOrEqual(viewport.width);
        expect((minimizedTooltipBounds?.y ?? viewport.height) + (minimizedTooltipBounds?.height ?? viewport.height)).toBeLessThanOrEqual(viewport.height);
        const restoreBounds = await owner.getByRole('button', {name: 'Return to group call'}).boundingBox();
        expect(minimizedTooltipBounds?.y).toBeGreaterThanOrEqual((bounds.rect.bottom) - 1);
        const tooltipOverlapsRestore = !!minimizedTooltipBounds && !!restoreBounds && minimizedTooltipBounds.x < restoreBounds.x + restoreBounds.width && minimizedTooltipBounds.x + minimizedTooltipBounds.width > restoreBounds.x && minimizedTooltipBounds.y < restoreBounds.y + restoreBounds.height && minimizedTooltipBounds.y + minimizedTooltipBounds.height > restoreBounds.y;
        expect(tooltipOverlapsRestore, `${theme}/${viewport.width}px minimized tooltip overlaps restore control: ${JSON.stringify({minimizedTooltipBounds, restoreBounds})}`).toBeFalsy();
        await owner.screenshot({path: testInfo.outputPath(`group-call-minimized-end-tooltip-${theme}-${viewport.width}.png`), fullPage: false, timeout: 15_000});
        await owner.mouse.move(0, 0);
        if (viewport.width === 390) {
          for (const control of [owner.getByRole('button', {name: 'Return to group call'}), minimizedEndCall]) {
            await control.focus();
            await owner.keyboard.press('Tab');
            await owner.keyboard.press('Shift+Tab');
            await expect(control).toBeFocused();
            const focus = await control.evaluate(element => ({visible: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle, width: Number.parseFloat(getComputedStyle(element).outlineWidth)}));
            expect(focus.visible && focus.outline !== 'none' && focus.width >= 2, `${theme}/390px minimized control focus: ${JSON.stringify(focus)}`).toBeTruthy();
            await control.evaluate(element => element.blur());
          }
        }
        await owner.screenshot({path: testInfo.outputPath(`group-call-minimized-${theme}-${viewport.width}.png`), fullPage: false, timeout: 15_000});
      }
    }
    await owner.setViewportSize({width: 1440, height: 900});
    await setTheme(owner, 'dark');
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
    await setTheme(owner, 'light');
    await setTheme(observer, 'dark');
    await owner.getByRole('button', {name: 'Minimize group call'}).click();
    await expect(owner.locator('.group-call-minimized')).toBeVisible();
    await owner.getByRole('button', {name: 'End group call for everyone'}).click();
    const ownerTerminal = owner.locator('app-call-terminal-notice .group-call-terminal');
    await expect(ownerTerminal).toBeVisible({timeout: 5_000});
    await expect(ownerTerminal).toContainText('Group call ended.');
    const ownerTerminalStyle = await ownerTerminal.evaluate(element => ({background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color}));
    const ownerTerminalContrast = await measureRenderedTextContrastAtSurface(ownerTerminal.locator('span'));
    expect(ownerTerminalContrast.ratio, `light owner terminal contrast: ${JSON.stringify({ownerTerminalStyle, ownerTerminalContrast})}`).toBeGreaterThanOrEqual(4.5);
    await owner.screenshot({path: testInfo.outputPath('group-call-terminal-owner-light-1440-immediate.png'), fullPage: false, timeout: 15_000});
    await owner.setViewportSize({width: 390, height: 844});
    await expect(ownerTerminal).toBeVisible();
    await owner.screenshot({path: testInfo.outputPath('group-call-terminal-owner-light-390-immediate.png'), fullPage: false, timeout: 15_000});
    await owner.setViewportSize({width: 1440, height: 900});
    await expect.poll(() => observer.evaluate(() => (window as Window & {__groupSyncRequests?: string[]}).__groupSyncRequests?.length ?? 0), {timeout: 20_000}).toBeGreaterThan(observerSyncsBeforeTerminal);
    await expect(observer.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 30_000});
    await expect(observer.locator('.group-call-devices')).not.toBeVisible();
    await expect(observer.locator('.group-call-actions')).not.toBeVisible();
    await expect(observer.locator('.group-call-terminal')).toBeVisible();
    await expect(observer.locator('app-call-terminal-notice')).toContainText('Group call ended.');
    const observerTerminal = observer.locator('app-call-terminal-notice .group-call-terminal');
    const observerTerminalStyle = await observerTerminal.evaluate(element => ({
      background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element).color,
      text: element.querySelector('span')?.textContent?.trim() ?? '',
    }));
    const observerTerminalContrast = await measureRenderedTextContrastAtSurface(observerTerminal.locator('span'));
    expect(observerTerminalStyle.text).toBe('Group call ended.');
    expect(observerTerminalContrast.ratio, `dark terminal notice contrast: ${JSON.stringify({observerTerminalStyle, observerTerminalContrast})}`).toBeGreaterThanOrEqual(4.5);
    await observer.screenshot({path: testInfo.outputPath('group-call-terminal-dark-1440-immediate.png'), fullPage: false, timeout: 15_000});
    await observer.setViewportSize({width: 390, height: 844});
    await expect(observerTerminal).toBeVisible();
    await observer.screenshot({path: testInfo.outputPath('group-call-terminal-dark-390-immediate.png'), fullPage: false, timeout: 15_000});
    // A fresh room begins at revision 1 even when the previous room ended at
    // a higher revision. The former member must receive a new Join prompt now,
    // without waiting for the old terminal notice to disappear.
    dropObserverTerminal = false;
    await setTheme(member, 'dark');
    await member.getByRole('button', {name: 'Join or start group audio call'}).click();
    await expect(owner.getByRole('button', {name: 'Join call'})).toBeVisible({timeout: 10_000});
    await owner.screenshot({path: testInfo.outputPath('group-call-second-room-incoming-light-1440.png'), fullPage: false});
    await owner.getByRole('button', {name: 'Join call'}).click();
    await expect(member.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000});
    await expect(owner.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000});
    await Promise.all([member, owner].map(page => assertGroupCallAudioConnected(page)));
    await member.screenshot({path: testInfo.outputPath('group-call-second-room-active-dark-1440.png'), fullPage: false});
    await member.getByRole('button', {name: 'End group call for everyone'}).click();
    await expect(owner.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 10_000});
    await expect(member.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 10_000});

    await owner.getByRole('button', {name: 'Join or start group audio call'}).click();
    await expect(member.getByRole('button', {name: 'Join call'})).toBeVisible({timeout: 10_000});
    await member.getByRole('button', {name: 'Join call'}).click();
    await expect(owner.locator('.group-call-panel')).toContainText('2 participants in the group call.', {timeout: 10_000});
    await owner.getByRole('button', {name: 'End group call for everyone'}).click();
    await expect(member.locator('.group-call-terminal')).toContainText('Group call ended.', {timeout: 10_000});
    await expect(owner.getByText('Group call unavailable: user is already in a call')).toHaveCount(0);
    await owner.setViewportSize({width: 390, height: 844});
    await setTheme(owner, 'light');
    await owner.evaluate(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {configurable: true, value: async () => Promise.reject(new DOMException('denied', 'NotAllowedError'))}));
    await owner.getByRole('button', {name: 'Join or start group audio call'}).click();
    await expect(owner.locator('.group-call-terminal')).toContainText('Microphone permission was denied.', {timeout: 5_000});
    expect(await owner.evaluate(() => ({width: window.innerWidth, height: window.innerHeight}))).toEqual({width: 390, height: 844});
    const groupCallErrorNotice = owner.locator('.group-call-terminal');
    const groupCallErrorBounds = await groupCallErrorNotice.boundingBox();
    expect(groupCallErrorBounds?.x).toBeGreaterThanOrEqual(0);
    expect((groupCallErrorBounds?.x ?? 390) + (groupCallErrorBounds?.width ?? 390)).toBeLessThanOrEqual(390);
    await owner.screenshot({path: testInfo.outputPath('group-call-error-light-390.png'), fullPage: false, timeout: 15_000});
  } finally {
    await Promise.allSettled([ownerContext.close(), memberContext.close(), observerContext.close()]);
  }
});
