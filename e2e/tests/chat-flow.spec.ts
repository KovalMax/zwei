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
    const device = document.querySelector<HTMLElement>('.call-devices .call-select');
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

test('register, create conversation, and deliver a message', async ({ browser }, testInfo) => {
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

  await register(alice, aliceEmail, 'Alice');
  await register(bob, bobEmail, 'Bob');
  await register(charlie, charlieEmail, 'Charlie');
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
        await alice.evaluate(() => {
          const mediaDevices = navigator.mediaDevices;
          Object.defineProperty(mediaDevices, 'getDisplayMedia', {
            configurable: true,
            value: async () => {
              const canvas = document.createElement('canvas');
              canvas.width = 1280;
              canvas.height = 720;
              const context = canvas.getContext('2d');
              if (context) {
                context.fillStyle = '#b84a3a';
                context.fillRect(0, 0, canvas.width, canvas.height);
              }
              const stream = canvas.captureStream(5);
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
        const desktopContentBox = await alice.locator('.call-panel-full .call-card-content').boundingBox();
        if (!desktopContentBox) {
          throw new Error('Desktop call content bounds were not available');
        }
        for (const box of desktopControlBoxes.slice(2)) {
          if (!box || box.y < desktopContentBox.y || box.y + box.height > desktopContentBox.y + desktopContentBox.height + 1) {
            throw new Error('Desktop screen-share controls were clipped by the call content surface');
          }
        }
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
       const mobileScreenBox = await mobileScreenStage.boundingBox();
       if (!mobileScreenBox || mobileScreenBox.x < mobilePanelBox.x || mobileScreenBox.x + mobileScreenBox.width > mobilePanelBox.x + mobilePanelBox.width + 1) {
         throw new Error('Mobile shared-screen stage escaped the call panel');
       }
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
         await expect(alice.getByRole('button', {name: 'Expand shared screen'})).toBeVisible();
         await alice.screenshot({path: testInfo.outputPath('call-active-mobile-light-top.png'), fullPage: false});
         const mobileStickyGeometry = await alice.locator('.call-panel-full .call-card-content').evaluate(element => {
           const content = element as HTMLElement;
           const profile = document.querySelector<HTMLElement>('.call-panel-full .call-profile');
           const contentBox = content.getBoundingClientRect();
           const profileAtTop = profile?.getBoundingClientRect();
           content.scrollTop = content.scrollHeight;
           const profileAtEnd = profile?.getBoundingClientRect();
           return {scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight, contentTop: contentBox.top, profileAtTop, profileAtEnd};
         });
         expect(mobileStickyGeometry.scrollTop).toBeGreaterThan(0);
         expect(Math.abs((mobileStickyGeometry.profileAtTop?.top || 0) - (mobileStickyGeometry.profileAtEnd?.top || 0))).toBeLessThanOrEqual(1);
         expect(mobileStickyGeometry.profileAtEnd?.bottom).toBeLessThanOrEqual(mobileStickyGeometry.contentTop + 1);
         await alice.screenshot({path: testInfo.outputPath('call-active-mobile-light.png'), fullPage: false});
       await alice.getByRole('button', {name: 'Expand shared screen'}).click();
       await expect(alice.getByRole('button', {name: 'Exit fullscreen'})).toBeVisible();
       await alice.screenshot({path: testInfo.outputPath('call-screen-share-fullscreen-mobile-light.png'), fullPage: false});
       await alice.getByRole('button', {name: 'Exit fullscreen'}).click();
       await alice.setViewportSize(desktop.viewport);
    await alice.getByRole('button', {name: 'Mute'}).click();
    await expect(alice.getByRole('button', {name: 'Unmute'})).toBeVisible();
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

   await aliceContext.close();
   await bobContext.close();
   await charlieContext.close();
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
