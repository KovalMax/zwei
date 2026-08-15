import { expect, Page, test } from '@playwright/test';

const password = 'Password123!';
const adminBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';

function uniqueEmail(name: string): string {
  return `e2e-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
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

async function callThemeColors(page: Page): Promise<{panel: string; text: string; card: string; cardText: string; action: string; actionText: string; device: string; control: string; controlBorder: string; icon: string; scrollTrack: string; scrollThumb: string}> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.call-panel');
    const card = document.querySelector<HTMLElement>('.call-card');
    const action = document.querySelector<HTMLElement>('.call-actions');
    const actionButton = document.querySelector<HTMLElement>('.call-actions button[mat-stroked-button]');
    const device = document.querySelector<HTMLElement>('.call-devices select');
    const control = document.querySelector<HTMLElement>('.call-actions button[mat-stroked-button]');
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

test('register, create conversation, and deliver a message', async ({ browser }) => {
  const aliceEmail = uniqueEmail('alice');
  const bobEmail = uniqueEmail('bob');
  const desktop = { viewport: { width: 2560, height: 1440 } };
  const aliceContext = await browser.newContext(desktop);
  const bobContext = await browser.newContext(desktop);
  await aliceContext.grantPermissions(['microphone'], {origin: 'https://chat.localhost'});
  await bobContext.grantPermissions(['microphone'], {origin: 'https://chat.localhost'});
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  await register(alice, aliceEmail, 'Alice');
  await register(bob, bobEmail, 'Bob');
  await expect(alice.getByRole('button', { name: 'Account menu' })).toBeVisible();
  await expect(alice.locator('.conversation-rail')).toBeVisible();
  await expect(alice.getByText(/is typing/)).not.toBeVisible();

   await alice.getByPlaceholder('Name or email').fill(bobEmail);
   await expect(alice.getByText(bobEmail)).toBeVisible();
   await alice.getByText(bobEmail).click();
  await expect(alice.getByText('No messages yet.')).toBeVisible();
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
      await expect(alice.locator('.call-collapse-button')).toBeVisible();
     await expect(alice.locator('.message-history')).not.toBeVisible();
     await expect(alice.locator('.composer')).not.toBeVisible();
     await expect(alice.locator('.call-profile')).toContainText('Bob');
     await expect(alice.getByLabel('Microphone input', {exact: true})).toBeVisible();
     await expect(alice.getByLabel('Speaker output', {exact: true})).toBeVisible();
     await expect(alice.getByText('Microphone active', {exact: true})).toBeVisible();
     await expect(alice.getByText('Speaker active', {exact: true})).toBeVisible();
     await expect(alice.getByLabel('Microphone input level')).toBeVisible();
      await expect(alice.getByLabel('Incoming audio level')).toBeVisible();
      await expect(alice.getByText(/Packets received:/)).toBeVisible();
      await expect(alice.getByText(/Output path:/)).toBeVisible();
      await expect(alice.locator('audio')).toHaveJSProperty('paused', false);
      await expect(bob.locator('audio')).toHaveJSProperty('paused', false);
      await bob.getByRole('button', {name: 'Minimize call'}).click();
      const incomingDuringCall = `incoming-during-call-${Date.now()}`;
      await bob.getByPlaceholder('Write a message…').fill(incomingDuringCall);
      await bob.getByRole('button', {name: 'Send message'}).click();
      await expect(bob.getByText(incomingDuringCall)).toBeVisible();
      await expect(alice.locator('.person-option').filter({hasText: 'Bob'}).locator('.unread-count')).toHaveText('1');
      await alice.getByRole('button', {name: 'Minimize call'}).click();
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
      await expect(alice.getByRole('button', {name: 'Mute'})).toBeVisible();
     await expect(alice.getByRole('button', {name: 'End call'})).toBeVisible();
     const mobileMuteBox = await alice.getByRole('button', {name: 'Mute'}).boundingBox();
     const mobileEndCallBox = await alice.getByRole('button', {name: 'End call'}).boundingBox();
      if (!mobileMuteBox || !mobileEndCallBox) {
        throw new Error('Mobile call controls bounds were not available');
      }
      expect(mobileEndCallBox.y).toBeGreaterThan(600);
      expect(mobileMuteBox.y + mobileMuteBox.height).toBeLessThanOrEqual(844);
      expect(mobileEndCallBox.y + mobileEndCallBox.height).toBeLessThanOrEqual(844);
      const mobileContent = alice.locator('.call-panel-full .call-card-content');
      expect(await mobileContent.evaluate(element => {
        const lastChild = element.lastElementChild;
        return lastChild ? element.scrollHeight - (lastChild.offsetTop + lastChild.offsetHeight) : 0;
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
      expect(mobileCollapseBox.y + mobileCollapseBox.height).toBeLessThanOrEqual(mobileProfileBox.y);
      await alice.setViewportSize(desktop.viewport);
    await alice.getByRole('button', {name: 'Mute'}).click();
    await expect(alice.getByRole('button', {name: 'Unmute'})).toBeVisible();
    await alice.getByRole('button', {name: 'End call'}).click();
    await expect(alice.locator('.person-option').filter({hasText: 'Bob'}).locator('.unread-count')).not.toBeVisible();
    await expect(bob.getByText('Call ended.')).toBeVisible();
    await expect(bob.locator('.call-diagnostics')).not.toBeVisible();
   await bob.locator('.person-option').filter({hasText: 'Alice'}).click();

   await bob.goto('/profile');
  await expect(bob.getByRole('heading', {name: 'Profile'})).toBeVisible();
  await alice.getByRole('button', {name: 'Start audio call'}).click();
  const offlineCallNotice = alice.getByText('Call unavailable: recipient is offline', {exact: true});
  await expect(offlineCallNotice).toHaveCount(1);
  await expect(offlineCallNotice).toBeVisible();
  await expect(offlineCallNotice).not.toBeVisible({timeout: 7_000});
  await bob.goto('/home');
  await expect(bob.getByPlaceholder('Write a message…')).toBeEnabled({timeout: 10_000});

   const messages = [`hello-${Date.now()}`, `follow-up-${Date.now()}`];
  const started = Date.now();
  await alice.getByPlaceholder('Write a message…').fill(messages[0]);
  await expect(alice.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await alice.getByPlaceholder('Write a message…').press('Enter');
  await expect(alice.getByText(messages[0])).toBeVisible({ timeout: 5_000 });
  await expect(bob.getByText(messages[0])).toBeVisible({ timeout: 5_000 });
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

  await aliceContext.close();
  await bobContext.close();
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
  await alice.getByPlaceholder('Name or email').fill(bobEmail);
  await alice.getByText(bobEmail).click();
  const bobConversation = bob.locator('.person-option').filter({hasText: 'Alice'});
  await expect(bobConversation).toBeVisible();
  await bobConversation.click();

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
  await alice.getByPlaceholder('Name or email').fill(bobEmail);
  await alice.getByText(bobEmail).click();
  await expect(bob.locator('.person-option').filter({hasText: 'Alice'})).toBeVisible();

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
