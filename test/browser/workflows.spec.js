const { test, expect } = require('@playwright/test');

test('tenant submits a request and owner downloads a report on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto('/');
  await page.getByRole('button', { name: 'Tenant', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Welcome home/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Property owners' })).toHaveCount(0);

  await page.getByRole('button', { name: '+ Report an issue' }).click();
  const modal = page.locator('.modal');
  await expect(modal).toBeVisible();
  const modalBounds = await modal.boundingBox();
  expect(modalBounds.width).toBeLessThanOrEqual(375);
  await page.getByLabel('Short title').fill('Browser test leaking sink');
  await page.getByLabel('Description').fill('Water is dripping beneath the kitchen sink.');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Browser test leaking sink')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Owner', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your homes at a glance' })).toBeVisible();
  await expect(page.getByText('Browser test leaking sink')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Occupancy CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^propertyflow-occupancy-\d{4}-\d{2}-\d{2}\.csv$/);

  const requestCard = page.locator('.request').filter({ hasText: 'Browser test leaking sink' });
  await requestCard.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByRole('heading', { name: 'Assign request to an agent' })).toBeVisible();
  await page.getByRole('button', { name: 'Assign work order' }).click();
  await expect(page.locator('.request').filter({ hasText: 'Browser test leaking sink' })).toContainText('assigned');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Primary agent', exact: true }).click();
  const assignedWork = page.getByRole('row').filter({ hasText: 'Browser test leaking sink' });
  await assignedWork.getByRole('button', { name: 'Start work' }).click();
  await expect(assignedWork).toContainText('in progress');
  await assignedWork.getByRole('button', { name: 'Complete' }).click();
  await expect(assignedWork).toContainText('completed');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Tenant', exact: true }).click();
  await expect(page.locator('.request').filter({ hasText: 'Browser test leaking sink' }).first()).toContainText('resolved');
  expect(pageErrors).toEqual([]);
});

test('agent can start an assigned work order', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Primary agent', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today’s field work' })).toBeVisible();

  const workOrder = page.getByRole('row').filter({ hasText: 'Water leak beneath kitchen sink' });
  await expect(page.getByRole('heading', { name: 'Your workflow guide' })).toBeVisible();
  await expect(page.getByText('PropertyFlow blocks completing a job before it has been started.')).toBeVisible();
  await workOrder.getByRole('button', { name: 'Start work' }).click();
  await expect(workOrder).toContainText('in progress');
  await expect(workOrder.getByRole('button', { name: 'Complete' })).toBeVisible();
});

test('all account types render their dashboards and core controls', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const pageErrors = [];
  const serverErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });

  const roles = [
    { button: 'Developer', heading: /Good morning/, section: 'Property owner accounts', action: '+ Add property owner' },
    { button: 'Owner', heading: 'Your homes at a glance', section: 'Unit rent roll', action: '+ Add property' },
    { button: 'Tenant', heading: /Welcome home/, section: 'Payment receipts', action: '+ Report an issue' },
    { button: 'Primary agent', heading: 'Today’s field work', section: 'Work order queue', action: 'Add photo' },
    { button: 'Backup agent', heading: 'Today’s field work', section: 'Work order queue' }
  ];

  for (const role of roles) {
    await page.goto('/');
    await page.getByRole('button', { name: role.button, exact: true }).click();
    await expect(page.getByRole('heading', { name: role.heading })).toBeVisible();
    await expect(page.getByRole('heading', { name: role.section })).toBeVisible();
    if (role.button === 'Developer') {
      await expect(page.getByRole('heading', { name: 'Platform service payments' })).toBeVisible();
      await page.getByRole('button', { name: '+ Record owner payment' }).click();
      await expect(page.getByRole('heading', { name: 'Record owner service payment' })).toBeVisible();
      await expect(page.getByText('The entry will stay pending and will not count as received revenue')).toBeVisible();
      await page.locator('#modalForm').getByRole('button', { name: 'Cancel' }).click();
    } else if (role.button === 'Tenant') {
      await page.getByRole('button', { name: 'Pay with M-Pesa' }).click();
      await expect(page.getByRole('heading', { name: 'Pay rent with M-Pesa' })).toBeVisible();
      await expect(page.locator('#modalForm')).toContainText('Sandbox Test Merchant');
      await expect(page.locator('#modalForm')).toContainText('174379');
      await expect(page.locator('#modalForm')).toContainText('no real funds will be transferred');
      await page.locator('#modalForm').getByRole('button', { name: 'Cancel' }).click();
    }
    await expect(page.getByRole('heading', { name: 'Your workflow guide' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open full flowchart' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.getByRole('button', { name: 'Notifications' }).click();
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    if (role.action === '+ Add property owner') {
      await page.getByRole('button', { name: role.action }).click();
      await expect(page.getByRole('heading', { name: 'Add property owner' })).toBeVisible();
      await page.locator('#modalForm').getByRole('button', { name: 'Cancel' }).click();
    } else if (role.action === '+ Add property') {
      await page.getByRole('button', { name: role.action }).click();
      await expect(page.getByRole('heading', { name: 'Add property' })).toBeVisible();
      await page.locator('#modalForm').getByRole('button', { name: 'Cancel' }).click();
    } else if (role.action === '+ Report an issue') {
      await page.getByRole('button', { name: role.action }).click();
      await expect(page.getByLabel('Short title')).toBeVisible();
      await page.locator('#modalForm').getByRole('button', { name: 'Cancel' }).click();
    } else if (role.action === 'Add photo') {
      const workOrder = page.getByRole('row').filter({ hasText: 'Water leak beneath kitchen sink' });
      await workOrder.getByRole('button', { name: 'Add photo' }).click();
      await expect(page.getByRole('heading', { name: 'Add repair photos' })).toBeVisible();
      await page.locator('#modalForm').getByRole('button', { name: 'Cancel' }).click();
    }

    await page.getByRole('button', { name: 'Sign out' }).click();
  }

  expect(pageErrors).toEqual([]);
  expect(serverErrors).toEqual([]);
});

test('developer creates an owner and the owner activates and signs in', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Developer', exact: true }).click();
  await page.getByRole('button', { name: '+ Add property owner' }).click();
  await page.getByLabel('Full name').fill('Browser Test Owner');
  const email = `browser-owner-${Date.now()}@example.test`;
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Create owner' }).click();

  const inviteUrl = await page.locator('#inviteLink').inputValue();
  expect(inviteUrl).toContain('/?invite=');
  await page.goto(inviteUrl);
  await page.locator('#activationPassword').fill('BrowserOwnerSecure123!');
  await page.locator('#activationConfirm').fill('BrowserOwnerSecure123!');
  await page.getByRole('button', { name: 'Set password' }).click();

  await page.locator('#email').fill(email);
  await page.locator('#password').fill('BrowserOwnerSecure123!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your homes at a glance' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('installable app shell and graphical flowchart are available offline without private API caching', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  await page.evaluate(() => navigator.serviceWorker.ready);

  const cachedPaths = await page.evaluate(async () => {
    const cacheName = (await caches.keys()).find(key => key.startsWith('propertyflow-shell-'));
    const cache = await caches.open(cacheName);
    return (await cache.keys()).map(request => new URL(request.url).pathname);
  });
  expect(cachedPaths).toContain('/flowchart.svg');
  expect(cachedPaths).toContain('/propertyflow-icon-192.png');
  expect(cachedPaths).toContain('/propertyflow-icon-512.png');
  expect(cachedPaths.some(path => path.startsWith('/api/'))).toBe(false);

  await context.setOffline(true);
  await page.goto('/flowchart.svg');
  await expect(page.locator('svg')).toBeVisible();
  await context.setOffline(false);
});

test('public documents are linked from sign-in and remain available without authentication', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Documents' }).first()).toHaveAttribute('href', '/documents');
  await page.getByRole('link', { name: 'Documents' }).first().click();
  await expect(page).toHaveTitle('PropertyFlow Legal and Customer Documents');
  await expect(page.getByText('Terms of Service')).toBeVisible();
  await expect(page.getByRole('link', { name: 'PDF' }).first()).toHaveAttribute('href', /Terms-of-Service\.pdf$/);
});

test('developer can inspect an owner dashboard without owner controls', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Developer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Property owner accounts' })).toBeVisible();
  await page.getByRole('button', { name: 'View dashboard' }).first().click();
  await expect(page.getByText('Developer read-only view')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your homes at a glance' })).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Add tenant' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Add agent' })).toHaveCount(0);
  await page.getByRole('button', { name: '← Return to Developer console' }).click();
  await expect(page.getByRole('heading', { name: 'Property owner accounts' })).toBeVisible();
});
