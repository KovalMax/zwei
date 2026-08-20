import { APIRequestContext, expect, Page, test } from '@playwright/test';

const password = 'Password123!';
const adminBase = process.env.ADMIN_BASE_URL ?? 'https://kyc.localhost';
const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'e2e-admin@example.test';
const basicAuthUser = process.env.KYC_BASIC_AUTH_USER ?? 'kyc-admin';
const basicAuthPassword = process.env.KYC_BASIC_AUTH_PASSWORD ?? 'local-basic-auth-change-me';

test.use({
  video: 'on',
  viewport: {width: 1280, height: 720},
  httpCredentials: {username: basicAuthUser, password: basicAuthPassword},
});

function uniqueEmail(name: string): string {
  return `demo-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
}

async function capture(page: Page, testInfo: {outputPath(path: string): string}, name: string, pause = 900): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({path: testInfo.outputPath(`${name}.png`), fullPage: false});
  await page.waitForTimeout(pause);
}

async function fillRegistration(page: Page, email: string, firstName: string, nickname: string): Promise<void> {
  await page.locator('[formControlName="email"]').fill(email);
  await page.locator('[formControlName="firstName"]').fill(firstName);
  await page.locator('[formControlName="lastName"]').fill('Demo');
  await page.locator('[formControlName="nickName"]').fill(nickname);
  await page.locator('[formControlName="password"]').fill(password);
  await page.locator('[formControlName="confirmPassword"]').fill(password);
}

async function register(page: Page, email: string, firstName: string, nickname: string, invitationCode?: string): Promise<void> {
  const suffix = invitationCode ? `?invite=1&code=${encodeURIComponent(invitationCode)}` : '';
  await page.goto(`/sign-up${suffix}`);
  await fillRegistration(page, email, firstName, nickname);
  await expect(page.getByRole('button', {name: 'Create account'})).toBeEnabled();
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create account'}).click();
  const response = await responsePromise;
  expect(response.status()).toBe(invitationCode ? 201 : 202);
  await expect(page).toHaveURL(invitationCode ? /\/home$/ : /\/pending$/);
}

async function createInvitation(request: APIRequestContext, email: string): Promise<string> {
  const loginResponse = await request.post(`${adminBase}/api/auth/login`, {
    data: {email: adminEmail, password, device_id: `demo-admin-${Date.now()}`, device_name: 'README demo'},
  });
  expect(loginResponse.ok()).toBeTruthy();
  const loginPayload = await loginResponse.json() as {access_token: string; token_type: string};
  const invitationResponse = await request.post(`${adminBase}/api/admin/invitations`, {
    headers: {Authorization: `${loginPayload.token_type} ${loginPayload.access_token}`},
    data: {email},
  });
  expect(invitationResponse.status()).toBe(201);
  const invitationPayload = await invitationResponse.json() as {code: string};
  return invitationPayload.code;
}

async function activationLink(request: APIRequestContext, email: string): Promise<string> {
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
    link = text.match(/https:\/\/chat\.localhost\/activate\?token=[A-Za-z0-9_-]+/)?.[0] ?? '';
    return link;
  }, {timeout: 10_000}).toBeTruthy();
  return link;
}

test('records the public README journey including admin activation and the Home preview', async ({browser, page, request}, testInfo) => {
  const demoEmail = uniqueEmail('user');
  const peerEmail = uniqueEmail('peer');

  // Set up an active peer outside the recorded page so the final Home preview has a real conversation target.
  const invitationCode = await createInvitation(request, peerEmail);
  const peerContext = await browser.newContext();
  const peer = await peerContext.newPage();
  await register(peer, peerEmail, 'Zwei', 'Zwei Guide', invitationCode);

  await page.goto('/sign-up');
  await capture(page, testInfo, '01-registration');
  await fillRegistration(page, demoEmail, 'Demo', 'Demo User');
  await capture(page, testInfo, '02-registration-filled');
  const registrationResponse = page.waitForResponse(response => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Create account'}).click();
  expect((await registrationResponse).status()).toBe(202);
  await expect(page).toHaveURL(/\/pending$/);
  await capture(page, testInfo, '03-pending');

  await page.goto(`${adminBase}/login`);
  await expect(page.getByText('ZWEI admin panel')).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Sign in to the admin panel'})).toBeVisible();
  await expect(page.getByText('Review accounts and manage invitations.')).toBeVisible();
  await page.locator('[formControlName="email"]').fill(adminEmail);
  await page.locator('[formControlName="password"]').fill(password);
  await capture(page, testInfo, '04-admin-login');
  await page.getByRole('button', {name: 'Sign in'}).click();
  await expect(page).toHaveURL(/\/admin$/);
  const pendingRow = page.locator('tbody tr').filter({hasText: demoEmail});
  await expect(pendingRow.getByRole('button', {name: 'Activate account'})).toBeEnabled();
  await capture(page, testInfo, '05-admin-panel');
  await pendingRow.getByRole('button', {name: 'Activate'}).click();
  await expect(page.getByText('Account activated.')).toBeVisible();
  await capture(page, testInfo, '06-admin-activated');

  const link = await activationLink(request, demoEmail);
  await page.goto(link);
  await expect(page.getByRole('heading', {name: 'Your account is active'})).toBeVisible();
  await capture(page, testInfo, '07-activated');
  await page.getByRole('button', {name: 'Continue to sign in'}).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.locator('[formControlName="email"]').fill(demoEmail);
  await page.locator('[formControlName="password"]').fill(password);
  await capture(page, testInfo, '08-login');
  await page.getByRole('button', {name: 'Sign in'}).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', {name: 'Choose a conversation'})).toBeVisible();
  await capture(page, testInfo, '09-home-empty');

  await page.getByPlaceholder('Name or email').fill(peerEmail);
  await expect(page.getByText(peerEmail)).toBeVisible();
  await page.getByText(peerEmail).click();
  await expect(page.getByRole('heading', {name: 'Zwei Guide'})).toBeVisible();
  await expect(page.getByText('No messages yet.')).toBeVisible();
  await capture(page, testInfo, '10-home-conversation', 1_500);

  await peerContext.close();
});
