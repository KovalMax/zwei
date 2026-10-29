import {expect, Page, request} from '@playwright/test';

// Fixture authentication must not alter the browser's cookie jar or its
// account chooser. Each API-only login owns an isolated cookie context.
export async function fixtureToken(base: string, email: string, password: string, deviceName: string): Promise<{access_token: string; token_type: string}> {
  const api = await request.newContext({ignoreHTTPSErrors: true});
  try {
    const response = await api.post(`${base}/api/auth/v2/login`, {
      headers: {Origin: base},
      data: {email, password, device_id: `e2e-${crypto.randomUUID()}`, device_name: deviceName},
    });
    expect(response.status()).toBe(200);
    return await response.json() as {access_token: string; token_type: string};
  } finally {
    await api.dispose();
  }
}

// Subscribe before navigation; restore can finish before goto/reload resolves.
export async function restoreSession(page: Page, navigate: () => Promise<unknown>, destination: 'home' | 'profile' | 'admin' = 'home', previousBinding?: string | null): Promise<void> {
  const previous = previousBinding ?? (page.url().startsWith('http') ? await page.evaluate(() => localStorage.getItem('zwei.intended-session')) : null);
  expect(previous, 'the intended account must exist before restoration').toBeTruthy();
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/v2/refresh' && response.request().method() === 'POST');
  await navigate();
  const response = await pending;
  expect(response.status()).toBe(200);
  const body = await response.json() as {access_token: string; browser_id: string; generation: string};
  const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString()) as {sub: string};
  // The response can arrive before Angular commits the rotated binding.
  await expect.poll(async () => {
    const stored = await page.evaluate(() => localStorage.getItem('zwei.intended-session'));
    if (!stored) return null;
    try {
      const binding = JSON.parse(stored) as {subject: string; browser_id: string; generation: string};
      return {subject: binding?.subject, browser_id: binding?.browser_id, generation: binding?.generation};
    } catch {
      return null;
    }
  }, {message: 'the restored account binding must be committed'}).toEqual({
    subject: claims.sub,
    browser_id: body.browser_id,
    generation: body.generation,
  });
  const request = response.request().postDataJSON() as {browser_id: string; generation: string};
  expect(request.browser_id).toBe(body.browser_id);
  if (previous) {
    const intended = JSON.parse(previous) as {subject: string; browser_id: string; generation: string};
    expect(claims.sub).toBe(intended.subject);
    expect(request).toMatchObject({browser_id: intended.browser_id, generation: intended.generation});
  }
  await expect(page).toHaveURL(new RegExp(`/${destination}$`));
}

export async function reloadSession(page: Page): Promise<void> {
  const destination = new URL(page.url()).pathname === '/profile' ? 'profile' : 'home';
  await restoreSession(page, () => page.reload(), destination);
}
