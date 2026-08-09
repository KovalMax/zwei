import { expect, Page, test } from '@playwright/test';

function uniqueEmail(name: string): string {
  return `e2e-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
}

async function register(page: import('@playwright/test').Page, email: string, nickname: string): Promise<void> {
  await page.goto('/sign-up');
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
  await expect(page).toHaveURL(/\/login$/);
}

async function login(page: import('@playwright/test').Page, email: string): Promise<void> {
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="password"]').fill('Password123!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function callThemeColors(page: Page): Promise<{panel: string; text: string; control: string; controlBorder: string; icon: string; scrollTrack: string; scrollThumb: string}> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('.call-panel');
    const control = document.querySelector<HTMLElement>('.call-actions button[mat-stroked-button]');
    const icon = document.querySelector<HTMLElement>('.call-button');
    const scrollSurface = document.querySelector<HTMLElement>('.message-history');
    const panelStyle = panel ? getComputedStyle(panel) : undefined;
    const scrollStyle = scrollSurface ? getComputedStyle(scrollSurface) : undefined;
    return {
      panel: panelStyle?.backgroundColor || '',
      text: panelStyle?.color || '',
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
  await login(alice, aliceEmail);
  await login(bob, bobEmail);
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

   await alice.getByPlaceholder('Write a message…').fill('typing');
   await expect(bob.getByText('Alice is typing…')).toBeVisible();
   await expect(bob.getByText('Alice is typing…')).not.toBeVisible({ timeout: 3_000 });

   await expect(alice.getByRole('button', {name: 'Start audio call'})).toBeEnabled();
   await alice.getByRole('button', {name: 'Start audio call'}).click();
   await expect(alice.getByText('Ringing...')).toBeVisible();
   await expect(bob.getByText('Incoming audio call.')).toBeVisible();
   await bob.getByRole('button', {name: 'Accept'}).click();
    await expect(alice.getByText('Audio call connected.')).toBeVisible({timeout: 10_000});
    await expect(bob.getByText('Audio call connected.')).toBeVisible({timeout: 10_000});
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
    expect(lightThemeColors.scrollThumb).not.toBe(darkThemeColors.scrollThumb);
    await alice.getByRole('button', {name: 'Mute'}).click();
   await expect(alice.getByRole('button', {name: 'Unmute'})).toBeVisible();
  await alice.getByRole('button', {name: 'End call'}).click();
  await expect(bob.getByText('Call ended.')).toBeVisible();

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
  await login(alice, aliceEmail);
  await login(bob, bobEmail);
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
