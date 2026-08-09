import {expect, Page, test} from '@playwright/test';

const password = 'Password123!';

function uniqueEmail(name: string): string {
  return `e2e-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
}

function input(page: Page, name: string) {
  return page.locator(`[formControlName="${name}"]`);
}

function field(page: Page, name: string) {
  return page.locator('mat-form-field').filter({has: input(page, name)});
}

async function register(page: Page, email: string, nickname = 'Test User'): Promise<void> {
  await page.goto('/sign-up');
  await input(page, 'email').fill(email);
  await input(page, 'firstName').fill('Test');
  await input(page, 'lastName').fill('User');
  await input(page, 'nickName').fill(nickname);
  await input(page, 'password').fill(password);
  await input(page, 'confirmPassword').fill(password);
  await page.getByRole('button', {name: 'Create account'}).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function login(page: Page, email: string, value = password): Promise<void> {
  await page.goto('/login');
  await input(page, 'email').fill(email);
  await input(page, 'password').fill(value);
  await page.getByRole('button', {name: 'Sign in'}).click();
}

test('serves the browser security headers', async ({request}) => {
  const response = await request.get('/');

  expect(response.ok()).toBeTruthy();
  expect(response.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(response.headers()['content-security-policy']).not.toContain('fonts.googleapis.com');
  expect(response.headers()['content-security-policy']).not.toContain('fonts.gstatic.com');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['x-frame-options']).toBe('DENY');
  expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(response.headers()['permissions-policy']).toContain('camera=()');
  expect(response.headers()['permissions-policy']).toContain('microphone=(self)');
});

test('shows every registration and login validation state', async ({page}) => {
  const thirdPartyAssetRequests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('fonts.googleapis.com') || request.url().includes('fonts.gstatic.com')) thirdPartyAssetRequests.push(request.url());
  });
  await page.goto('/sign-up');
  await expect(page.getByRole('heading', {name: 'Create your account'})).toBeVisible();
  await expect(page.locator('zwei-icon').first().locator('svg')).toBeVisible();
  expect(thirdPartyAssetRequests).toEqual([]);
  await expect(page.getByRole('button', {name: 'Create account'})).toBeDisabled();

  for (const name of ['email', 'firstName', 'lastName', 'nickName', 'password', 'confirmPassword']) {
    await input(page, name).focus();
    await input(page, name).blur();
  }
  await expect(field(page, 'email').getByText('Email is required.')).toBeVisible();
  await expect(field(page, 'firstName').getByText('First name is required.')).toBeVisible();
  await expect(field(page, 'lastName').getByText('Last name is required.')).toBeVisible();
  await expect(field(page, 'nickName').getByText('Nickname is required.')).toBeVisible();
  await expect(field(page, 'password').getByText('Password is required.')).toBeVisible();
  await expect(field(page, 'confirmPassword').getByText('Please confirm your password.')).toBeVisible();

  await input(page, 'email').fill('not-an-email');
  await input(page, 'email').blur();
  await expect(field(page, 'email').getByText('Enter a valid email.')).toBeVisible();
  await input(page, 'email').fill(`${'a'.repeat(172)}@test.com`);
  await input(page, 'email').blur();
  await expect(field(page, 'email').getByText('Email is too long.')).toBeVisible();

  for (const name of ['firstName', 'lastName', 'nickName']) {
    await input(page, name).fill('A');
    await input(page, name).blur();
    await expect(field(page, name).getByText('Use at least 2 characters.')).toBeVisible();
    await input(page, name).fill('A'.repeat(61));
    await input(page, name).blur();
    await expect(field(page, name).getByText(/is too long\./)).toBeVisible();
  }

  await input(page, 'password').fill('short');
  await input(page, 'password').blur();
  await expect(field(page, 'password').getByText('Use at least 8 characters.')).toBeVisible();
  await input(page, 'password').fill('A'.repeat(65));
  await input(page, 'password').blur();
  await expect(field(page, 'password').getByText('Password is too long.')).toBeVisible();
  await input(page, 'password').fill(password);
  await input(page, 'confirmPassword').fill('Different1!');
  await input(page, 'confirmPassword').blur();
  await expect(page.getByText('Passwords do not match.')).toBeVisible();

  await page.goto('/login');
  await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Sign in'})).toBeDisabled();
  await input(page, 'email').focus();
  await input(page, 'email').blur();
  await input(page, 'password').focus();
  await input(page, 'password').blur();
  await expect(field(page, 'email').getByText('Email is required.')).toBeVisible();
  await expect(field(page, 'password').getByText('Password is required.')).toBeVisible();
  await input(page, 'email').fill('not-an-email');
  await input(page, 'email').blur();
  await expect(field(page, 'email').getByText('Enter a valid email.')).toBeVisible();
});

test('uses the light auth theme when selected before the application starts', async ({page}) => {
  await page.addInitScript(() => localStorage.setItem('zwei_theme', 'light'));
  await page.goto('/login');

  await expect(page.locator('html')).toHaveClass(/light-theme/);
  await expect(page.locator('body')).toHaveClass(/light-theme/);
  await expect(page.locator('.auth-card')).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.78)');
  await expect(page.getByRole('heading', {name: 'Sign in to zwei'})).toHaveCSS('color', 'rgb(23, 28, 43)');
});

test('keeps registration keyboard-accessible on a reduced-motion mobile viewport', async ({browser}) => {
  const context = await browser.newContext({
    viewport: {width: 390, height: 844},
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.goto('/sign-up');

  const email = input(page, 'email');
  const firstName = input(page, 'firstName');
  const lastName = input(page, 'lastName');
  await email.focus();
  await email.press('Tab');
  await expect(firstName).toBeFocused();
  await expect(firstName.locator('xpath=ancestor::mat-form-field')).toHaveClass(/mat-focused/);
  const firstBox = await firstName.boundingBox();
  const lastBox = await lastName.boundingBox();
  expect(lastBox?.y).toBeGreaterThan(firstBox?.y || 0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--zwei-motion-duration').trim())).toBe('0ms');

  await context.close();
});

test('registers, rejects duplicate and invalid login, then exposes profile and sign out', async ({page}) => {
  const email = uniqueEmail('account');
  await register(page, email, 'Account User');

  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/sign-up');
  await input(page, 'email').fill(email);
  await input(page, 'firstName').fill('Test');
  await input(page, 'lastName').fill('User');
  await input(page, 'nickName').fill('Account User');
  await input(page, 'password').fill(password);
  await input(page, 'confirmPassword').fill(password);
  await page.getByRole('button', {name: 'Create account'}).click();
  await expect(page.getByText('An account with this email already exists. Try signing in instead.')).toBeVisible();

  await login(page, email, 'WrongPassword1!');
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  await login(page, email);
  await expect(page).toHaveURL(/\/home$/);
  const refreshResponse = page.waitForResponse(response => response.url().endsWith('/api/auth/refresh') && response.request().method() === 'POST');
  await page.reload();
  expect((await refreshResponse).status()).toBe(200);
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('button', {name: 'Account menu'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Choose a conversation'})).toBeVisible();
  await expect(page.getByPlaceholder('Name or email')).toBeVisible();
  await expect(page.getByLabel('Message composer disabled until a conversation is selected')).toBeVisible();

  await page.getByRole('button', {name: 'Account menu'}).click();
  await expect(page.getByRole('menuitem', {name: 'Profile'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Sign out'})).toBeVisible();
  await page.getByRole('menuitem', {name: 'Profile'}).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('heading', {name: 'Profile'})).toBeVisible();
  await expect(page.locator('.profile-card').getByText(email)).toBeVisible();
  await expect(page.getByRole('link', {name: 'Back to chats'})).toBeVisible();

  await page.getByRole('button', {name: 'Account menu'}).click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(page).toHaveURL(/\/login$/);
});
