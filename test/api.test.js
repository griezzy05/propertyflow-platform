const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function createObjectStore() {
  const objects = new Map();
  const server = http.createServer(async (req, res) => {
    const pathName = new URL(req.url, 'http://localhost').pathname;
    const key = decodeURIComponent(pathName.replace(/^\/test-bucket\//, ''));
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { ETag: '"test-object"' });
      return res.end();
    }
    if (req.method === 'GET') {
      const body = objects.get(key);
      if (!body) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'application/octet-stream' });
      return res.end(body);
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(405);
    return res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, endpoint: `http://127.0.0.1:${server.address().port}`, objects };
}

test('role workflows, invitations, unit tracking, and payment configuration', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propertyflow-api-'));
  const port = await unusedPort();
  const objectStore = await createObjectStore();
  const storeFile = path.join(directory, 'store.json');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      APP_BASE_URL: `http://127.0.0.1:${port}`,
      PROPERTYFLOW_STORE_FILE: storeFile,
      DARAJA_ENVIRONMENT: 'sandbox',
      DARAJA_SHORTCODE: '174379',
      DARAJA_RECIPIENT_NAME: 'Sandbox Test Merchant',
      DARAJA_CONSUMER_KEY: '',
      DARAJA_CALLBACK_TOKEN: '',
      STORAGE_BUCKET: 'test-bucket',
      STORAGE_REGION: 'us-east-1',
      STORAGE_ENDPOINT: objectStore.endpoint,
      STORAGE_ACCESS_KEY_ID: 'test-access-key',
      STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
      STORAGE_FORCE_PATH_STYLE: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await new Promise(resolve => objectStore.server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let healthChecked = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`PropertyFlow exited before startup: ${serverOutput}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        healthChecked = true;
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
    if (attempt === 39) throw new Error(`PropertyFlow did not start: ${serverOutput}`);
  }
  assert.equal(healthChecked, true);
  const homepage = await fetch(base);
  assert.equal(homepage.status, 200);
  const homepageHtml = await homepage.text();
  assert.match(homepageHtml, /notificationButton/);
  assert.match(homepageHtml, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
  assert.match(homepageHtml, /rel="manifest" href="\/manifest\.webmanifest"/);
  const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get('content-type'), /application\/manifest\+json/);
  assert.equal((await manifestResponse.json()).display, 'standalone');
  for (const icon of ['/propertyflow-icon-192.png', '/propertyflow-icon-512.png']) {
    const iconResponse = await fetch(`${base}${icon}`);
    assert.equal(iconResponse.status, 200);
    assert.match(iconResponse.headers.get('content-type'), /image\/png/);
  }
  const serviceWorkerResponse = await fetch(`${base}/sw.js`);
  assert.equal(serviceWorkerResponse.status, 200);
  assert.match(await serviceWorkerResponse.text(), /url\.pathname\.startsWith\('\/api\/'\)/);
  const flowchartResponse = await fetch(`${base}/flowchart.svg`);
  assert.equal(flowchartResponse.status, 200);
  assert.match(flowchartResponse.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await flowchartResponse.text(), /PropertyFlow end-to-end system flow/);
  const documentsResponse = await fetch(`${base}/documents`);
  assert.equal(documentsResponse.status, 200);
  assert.match(documentsResponse.headers.get('content-type'), /text\/html/);
  assert.match(await documentsResponse.text(), /PropertyFlow Legal and Customer Documents/);
  const publicDocumentResponse = await fetch(`${base}/documents/1-Legal/Privacy-Policy.md`);
  assert.equal(publicDocumentResponse.status, 200);
  assert.match(publicDocumentResponse.headers.get('content-type'), /text\/markdown/);
  assert.match(await publicDocumentResponse.text(), /DRAFT/);
  const internalDocumentResponse = await fetch(`${base}/documents/%2e%2e%2fFINAL_SYSTEM_DESIGN.md`);
  assert.equal(internalDocumentResponse.status, 403);
  assert.match(homepageHtml, /@media\(max-width:700px\)/);
  assert.match(homepageHtml, /min-height:42px/);
  assert.match(homepageHtml, /\.nav button\{width:auto;flex:0 0 auto/);
  const notificationScript = await fetch(`${base}/notifications.js`);
  assert.equal(notificationScript.status, 200);
  assert.match(await notificationScript.text(), /markAllNotificationsRead/);

  async function api(route, method = 'GET', body, token, expected = 200) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}${response.status >= 500 ? `\n${serverOutput}` : ''}`);
    return data;
  }

  async function upload(route, contentType, bytes, token, expected = 201) {
    const response = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: bytes
    });
    const data = await response.json();
    assert.equal(response.status, expected, `POST ${route}: ${JSON.stringify(data)}`);
    return data;
  }

  async function login(email, password) {
    return (await api('/api/auth/login', 'POST', { email, password })).token;
  }

  function inviteToken(invitationPath) {
    return new URL(invitationPath, base).searchParams.get('invite');
  }

  async function activate(invitationPath, password) {
    return api('/api/auth/activate', 'POST', { token: inviteToken(invitationPath), password });
  }

  const config = await api('/api/config');
  assert.equal(config.demoAccountsEnabled, true);
  assert.equal(config.mpesaEnabled, false);
  assert.equal(config.mpesaEnvironment, 'sandbox');
  assert.equal(config.mpesaShortcode, '174379');
  assert.equal(config.mpesaRecipientName, 'Sandbox Test Merchant');
  assert.equal(config.fileStorageEnabled, true);

  const developer = await login('developer@propertyflow.local', 'Welcome123!');
  await api('/api/admins', 'POST', {}, developer, 404);
  await api('/api/owners', 'POST', {
    name: 'Underallocated Owner',
    email: 'underallocated@example.test',
    tenantSeatAllocation: 49,
    agentSeatAllocation: 1
  }, developer, 422);
  const ownerInvite = await api('/api/owners', 'POST', {
    name: 'Test Owner',
    email: 'test-owner@example.test',
    tenantSeatAllocation: 55,
    agentSeatAllocation: 1
  }, developer, 201);
  assert.equal(ownerInvite.email.status, 'not_configured');
  await activate(ownerInvite.invitationPath, 'SecureOwnerPass123!');
  const owner = await login('test-owner@example.test', 'SecureOwnerPass123!');
  assert.equal((await api('/api/auth/me', 'GET', undefined, owner)).user.role, 'owner');
  const developerOwnerView = await api(`/api/dashboard?ownerId=${encodeURIComponent(ownerInvite.owner.id)}`, 'GET', undefined, developer);
  assert.equal(developerOwnerView.role, 'owner');
  assert.equal(developerOwnerView.readOnlyDeveloperView, true);
  await api(`/api/dashboard?ownerId=${encodeURIComponent(ownerInvite.owner.id)}`, 'GET', undefined, owner, 403);
  const pendingPlatformPayment = await api('/api/platform-payments', 'POST', {
    ownerId: ownerInvite.owner.id,
    amount: 1500,
    method: 'mpesa',
    reference: 'OWNER-SERVICE-001',
    paidOn: '2026-11-24'
  }, developer, 201);
  assert.equal(pendingPlatformPayment.payment.status, 'pending');
  await api('/api/platform-payments', 'POST', {
    ownerId: ownerInvite.owner.id,
    amount: 1500,
    method: 'mpesa',
    reference: 'owner-service-001',
    paidOn: '2026-11-24'
  }, developer, 409);
  await api('/api/platform-payments', 'POST', {
    ownerId: ownerInvite.owner.id,
    amount: -1,
    method: 'mpesa',
    reference: 'OWNER-SERVICE-INVALID',
    paidOn: '2026-11-24'
  }, developer, 422);
  await api('/api/platform-payments', 'POST', {
    ownerId: ownerInvite.owner.id,
    amount: 1500,
    method: 'mpesa',
    reference: 'OWNER-SERVICE-FORBIDDEN',
    paidOn: '2026-11-24'
  }, owner, 403);
  let developerDashboard = await api('/api/dashboard', 'GET', undefined, developer);
  assert.equal(developerDashboard.metrics.platformRevenueReceived, 0);
  assert.equal(developerDashboard.metrics.platformPaymentsPending, 1500);
  assert.equal(developerDashboard.platformPayments[0].ownerName, 'Test Owner');
  assert.equal((await api('/api/dashboard', 'GET', undefined, owner)).platformPayments, undefined);
  await api(`/api/platform-payments/${pendingPlatformPayment.payment.id}/review`, 'PATCH', {
    action: 'confirm'
  }, developer);
  developerDashboard = await api('/api/dashboard', 'GET', undefined, developer);
  assert.equal(developerDashboard.metrics.platformRevenueReceived, 1500);
  assert.equal(developerDashboard.metrics.platformPaymentsPending, 0);
  await api(`/api/platform-payments/${pendingPlatformPayment.payment.id}/review`, 'PATCH', {
    action: 'confirm'
  }, developer, 409);
  const rejectedPlatformPayment = await api('/api/platform-payments', 'POST', {
    ownerId: ownerInvite.owner.id,
    amount: 2500,
    method: 'bank',
    reference: 'OWNER-SERVICE-002',
    paidOn: '2026-11-24'
  }, developer, 201);
  await api(`/api/platform-payments/${rejectedPlatformPayment.payment.id}/review`, 'PATCH', {
    action: 'reject'
  }, developer);
  developerDashboard = await api('/api/dashboard', 'GET', undefined, developer);
  assert.equal(developerDashboard.metrics.platformRevenueReceived, 1500);
  assert.equal(developerDashboard.platformPayments[0].status, 'rejected');
  const welcome = await api('/api/notifications', 'GET', undefined, owner);
  assert.equal(welcome.unreadCount, 1);
  const welcomeNotification = welcome.notifications[0];
  await api(`/api/notifications/${welcomeNotification.id}`, 'PATCH', { read: true }, owner);
  assert.equal((await api('/api/notifications', 'GET', undefined, owner)).unreadCount, 0);
  await api(`/api/notifications/${welcomeNotification.id}`, 'PATCH', { read: false }, developer, 404);

  const seededOwner = await login('owner@propertyflow.local', 'Welcome123!');
  const seededOwnerDashboard = await api('/api/dashboard', 'GET', undefined, seededOwner);
  assert.equal(seededOwnerDashboard.paymentSettings.mpesaPhone.enabled, false);
  assert.ok(seededOwnerDashboard.units.some(unit => unit.unitNumber === 'B-12'));
  assert.ok(seededOwnerDashboard.leases.some(lease => lease.tenantName === 'Brian Otieno'));

  const property = (await api('/api/properties', 'POST', {
    name: 'Test Court',
    address: '1 Test Lane',
    totalUnits: 2
  }, owner, 201)).property;
  const unit = (await api(`/api/properties/${property.id}/units`, 'POST', {
    unitNumber: 'A-1',
    unitType: 'apartment',
    bedrooms: 1,
    askingRent: 30000
  }, owner, 201)).unit;
  assert.equal(unit.unitCode, 'TC-A-1');
  assert.equal(unit.status, 'vacant');
  assert.equal(Object.hasOwn(unit, 'qrTokenHash'), false);
  await api(`/api/properties/${property.id}/units`, 'POST', { unitNumber: 'A-1' }, owner, 409);
  const firstQr = await api(`/api/units/${unit.id}/qr`, 'POST', undefined, owner);
  assert.match(firstQr.qrCode, /^data:image\/png;base64,/);
  const firstQrToken = new URL(firstQr.qrUrl).pathname.split('/').at(-1);
  assert.equal((await api(`/api/units/resolve/${firstQrToken}`, 'GET', undefined, owner)).unit.id, unit.id);
  await api(`/api/units/resolve/${firstQrToken}`, 'GET', undefined, undefined, 401);
  const qrRedirect = await fetch(firstQr.qrUrl, { redirect: 'manual' });
  assert.equal(qrRedirect.status, 302);
  assert.equal(qrRedirect.headers.get('location'), `/?unit=${firstQrToken}`);
  const agentInvite = await api('/api/agents', 'POST', {
    name: 'Test Agent',
    email: 'test-agent@example.test',
    ownerId: ownerInvite.owner.id,
    agentType: 'primary'
  }, owner, 201);
  await activate(agentInvite.invitationPath, 'SecureAgentPass123!');
  let agent = await login('test-agent@example.test', 'SecureAgentPass123!');
  await api(`/api/units/resolve/${firstQrToken}`, 'GET', undefined, agent, 403);

  const tenantInvite = await api('/api/tenants', 'POST', {
    name: 'Test Tenant',
    email: 'test-tenant@example.test',
    phone: '0712345678',
    unitId: unit.id,
    rentAmount: 25000,
    depositAmount: 25000,
    leaseStartDate: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    leaseEnds: '2027-12-31',
    nextRentDue: '2026-12-01'
  }, owner, 201);
  await activate(tenantInvite.invitationPath, 'SecureTenantPass123!');
  let tenant = await login('test-tenant@example.test', 'SecureTenantPass123!');

  const paymentSettings = {
    mpesaPhone: { enabled: true, phoneNumber: '0712345678', recipientName: 'Test Owner' },
    mpesaPaybill: { enabled: false, type: 'paybill', number: '', accountReference: '', recipientName: '' },
    mpesaBank: { enabled: false, bankName: '', paybillNumber: '', accountNumber: '', accountName: '' },
    bankTransfer: { enabled: true, bankName: 'Test Bank', accountName: 'Test Owner', accountNumber: '123456789', branch: 'Nairobi' },
    cash: { enabled: true, instructions: 'Pay the owner and request a receipt.' }
  };
  await api('/api/payment-settings', 'PATCH', {
    mpesaPhone: { enabled: true, phoneNumber: '123', recipientName: '' }
  }, owner, 422);
  await api('/api/payment-settings', 'PATCH', paymentSettings, owner);
  await api('/api/payment-settings', 'PATCH', paymentSettings, tenant, 403);
  const tenantDashboard = await api('/api/dashboard', 'GET', undefined, tenant);
  assert.equal(tenantDashboard.metrics.currentBalance, 25000);
  assert.equal(tenantDashboard.paymentSettings.mpesaPhone.phoneNumber, '+254712345678');
  assert.equal(tenantDashboard.paymentSettings.bankTransfer.accountNumber, '123456789');
  assert.equal(tenantDashboard.property.occupiedUnits, 1);
  assert.equal(tenantDashboard.unit.id, unit.id);
  assert.equal(tenantDashboard.lease.depositAmount, 25000);
  assert.equal(tenantDashboard.lease.status, 'active');
  const tenantPaymentReport = await api('/api/payments/tenant-report', 'POST', {
    method: 'mpesa_phone',
    amount: 5000,
    reference: 'TENANT-MPESA-001'
  }, tenant, 201);
  assert.equal(tenantPaymentReport.payment.status, 'review');
  assert.equal((await api('/api/dashboard', 'GET', undefined, tenant)).metrics.currentBalance, 25000);
  await api('/api/payments/tenant-report', 'POST', {
    method: 'mpesa_paybill',
    amount: 1000,
    reference: 'TENANT-DISABLED-METHOD'
  }, tenant, 422);
  await api('/api/payments/tenant-report', 'POST', {
    method: 'bank',
    amount: 25000,
    reference: 'TENANT-OVER-REPORT'
  }, tenant, 409);
  await api('/api/payments/tenant-report', 'POST', {
    method: 'mpesa_phone',
    amount: 1000,
    reference: 'tenant-mpesa-001'
  }, tenant, 409);
  assert.ok((await api('/api/dashboard', 'GET', undefined, owner)).payments
    .some(payment => payment.id === tenantPaymentReport.payment.id && payment.status === 'review'));
  await api(`/api/payments/${tenantPaymentReport.payment.id}/reconcile`, 'PATCH', {
    action: 'reject',
    reason: 'Rejected as part of the payment workflow test.'
  }, owner);
  const leasePdf = Buffer.from('%PDF-1.7\nprivate test lease', 'ascii');
  const uploadedLease = await upload(
    `/api/files?purpose=lease-document&leaseId=${tenantDashboard.lease.id}&name=signed-lease.pdf`,
    'application/pdf', leasePdf, owner
  );
  assert.equal(uploadedLease.file.name, 'signed-lease.pdf');
  assert.equal(Object.hasOwn(uploadedLease.file, 'objectKey'), false);
  const tenantLeaseLink = await api(`/api/files/${uploadedLease.file.id}`, 'GET', undefined, tenant);
  assert.equal(tenantLeaseLink.file.id, uploadedLease.file.id);
  assert.deepEqual(Buffer.from(await (await fetch(tenantLeaseLink.downloadUrl)).arrayBuffer()), leasePdf);
  await api(`/api/files/${uploadedLease.file.id}`, 'GET', undefined, agent, 403);
  await api(`/api/files/${uploadedLease.file.id}`, 'GET', undefined, undefined, 401);
  assert.equal((await api(`/api/units/resolve/${firstQrToken}`, 'GET', undefined, tenant)).unit.id, unit.id);
  const rotatedQr = await api(`/api/units/${unit.id}/qr`, 'POST', undefined, owner);
  const rotatedQrToken = new URL(rotatedQr.qrUrl).pathname.split('/').at(-1);
  assert.notEqual(rotatedQrToken, firstQrToken);
  await api(`/api/units/resolve/${firstQrToken}`, 'GET', undefined, owner, 404);
  assert.equal((await fetch(firstQr.qrUrl, { redirect: 'manual' })).status, 404);
  assert.equal((await api(`/api/units/resolve/${rotatedQrToken}`, 'GET', undefined, tenant)).unit.id, unit.id);
  const rentChangeDate = new Date().toISOString().slice(0, 10);
  await api(`/api/properties/${property.id}/units`, 'POST', { unitNumber: 'A-2' }, tenant, 403);
  await api(`/api/leases/${tenantDashboard.lease.id}/rent`, 'PATCH', {
    rentAmount: 27000,
    effectiveDate: rentChangeDate
  }, agent, 403);
  const rentChange = await api(`/api/leases/${tenantDashboard.lease.id}/rent`, 'PATCH', {
    rentAmount: 27000,
    effectiveDate: rentChangeDate
  }, owner);
  assert.equal(rentChange.lease.currentRent, 27000);
  assert.equal(rentChange.lease.rentHistory.length, 2);
  await api(`/api/leases/${tenantDashboard.lease.id}/rent`, 'PATCH', {
    rentAmount: 28000,
    effectiveDate: rentChangeDate
  }, owner, 409);
  assert.equal((await api('/api/dashboard', 'GET', undefined, tenant)).metrics.currentBalance, 27000);
  await api('/api/reminder-settings', 'GET', undefined, tenant, 403);
  const defaultReminderSettings = await api('/api/reminder-settings', 'GET', undefined, owner);
  assert.deepEqual(defaultReminderSettings.settings.days, [-3, 0, 3, 7]);
  const savedReminderSettings = await api('/api/reminder-settings', 'PATCH', {
    enabled: true,
    days: [-5, 0, 5],
    leaseDays: [60, 14, 0]
  }, owner);
  assert.deepEqual(savedReminderSettings.settings.days, [-5, 0, 5]);
  await api('/api/reminder-settings', 'PATCH', {
    enabled: true,
    days: [-31],
    leaseDays: [7]
  }, owner, 422);
  await api('/api/reminder-history', 'GET', undefined, owner);
  await api('/api/audit-logs', 'GET', undefined, tenant, 403);

  const rentDueDate = tenantDashboard.metrics.nextRentDue;
  const manualPayment = await api('/api/payments/manual', 'POST', {
    tenantId: tenantInvite.tenant.id,
    amount: 27000,
    method: 'bank',
    reference: '=SUM(1,1)',
    dueDate: rentDueDate
  }, owner, 201);
  assert.equal(manualPayment.payment.status, 'review');
  await api('/api/payments/manual', 'POST', {
    tenantId: tenantInvite.tenant.id,
    amount: 27000,
    method: 'bank',
    reference: '=SUM(1,1)',
    dueDate: rentDueDate
  }, owner, 409);
  await api('/api/payments/manual', 'POST', {
    tenantId: tenantInvite.tenant.id,
    amount: 27000,
    method: 'bank',
    reference: 'UNAUTHORIZED-RECORD',
    dueDate: rentDueDate
  }, tenant, 403);
  await api(`/api/payments/${manualPayment.payment.id}/reconcile`, 'PATCH', { action: 'confirm' }, agent, 403);
  const confirmedPayment = await api(`/api/payments/${manualPayment.payment.id}/reconcile`, 'PATCH', {
    action: 'confirm'
  }, owner);
  assert.equal(confirmedPayment.payment.status, 'paid');
  assert.match(confirmedPayment.payment.receiptNumber, /^PF-/);
  const paymentReceipt = await api(`/api/payments/${manualPayment.payment.id}/receipt`, 'GET', undefined, tenant);
  assert.equal(paymentReceipt.receipt.amount, 27000);
  assert.equal(paymentReceipt.receipt.reference, '=SUM(1,1)');
  const balanceAfterPayment = await api('/api/dashboard', 'GET', undefined, tenant);
  assert.notEqual(balanceAfterPayment.metrics.nextRentDue, rentDueDate);
  assert.equal(balanceAfterPayment.metrics.currentBalance, 27000);
  const auditResult = await api('/api/audit-logs?limit=100', 'GET', undefined, owner);
  assert.ok(auditResult.auditLogs.some(entry => entry.action === 'tenant.assigned'));
  assert.ok(auditResult.auditLogs.some(entry => entry.action === 'payment.confirmed' && entry.ownerId === ownerInvite.owner.id));
  assert.ok(auditResult.auditLogs.some(entry => entry.action === 'lease.rent_changed'));
  const ownerPayments = await api('/api/payments', 'GET', undefined, owner);
  assert.ok(ownerPayments.payments.some(payment => payment.id === manualPayment.payment.id));
  for (const reportType of ['rent', 'arrears', 'occupancy', 'maintenance', 'lease-expiry']) {
    const response = await fetch(`${base}/api/reports?type=${reportType}`, { headers: { Authorization: `Bearer ${owner}` } });
    assert.equal(response.status, 200, `${reportType} report should download`);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    const reportCsv = await response.text();
    assert.ok(reportCsv === 'No records\r\n' || reportCsv.startsWith('"property"'), `${reportType} report should be valid CSV`);
  }
  const rentReport = await fetch(`${base}/api/reports?type=rent`, { headers: { Authorization: `Bearer ${owner}` } });
  assert.match(await rentReport.text(), /"'=SUM\(1,1\)"/);
  await api('/api/reports?type=rent', 'GET', undefined, tenant, 403);
  await api('/api/payments/mpesa/stk-push', 'POST', { phone: '0712345678' }, tenant, 503);
  await api('/api/properties', 'POST', { name: 'Forbidden', address: 'Nowhere', totalUnits: 1 }, tenant, 403);

  const submission = await api('/api/requests', 'POST', {
    title: 'Leaking tap',
    details: 'Tap is leaking in kitchen.',
    type: 'Maintenance issue',
    priority: 'high'
  }, tenant, 201);
  const requestPhoto = Buffer.from('89504e470d0a1a0a00000000','hex');
  const uploadedPhoto = await upload(
    `/api/files?purpose=request-photo&requestId=${submission.request.id}&name=sink-leak.png`,
    'image/png', requestPhoto, tenant
  );
  assert.equal(uploadedPhoto.file.purpose, 'request-photo');
  await api(`/api/files/${uploadedPhoto.file.id}`, 'GET', undefined, agent, 403);
  await api(`/api/files/${uploadedPhoto.file.id}`, 'GET', undefined, owner);
  const fileDownload = await api(`/api/files/${uploadedPhoto.file.id}`, 'GET', undefined, tenant);
  assert.deepEqual(Buffer.from(await (await fetch(fileDownload.downloadUrl)).arrayBuffer()), requestPhoto);
  await upload(
    `/api/files?purpose=request-photo&requestId=${submission.request.id}&name=bad.txt`,
    'text/plain', Buffer.from('not an image'), tenant, 415
  );
  await api('/api/files', 'POST', {}, tenant, 422);
  const ownerNotifications = await api('/api/notifications', 'GET', undefined, owner);
  assert.ok(ownerNotifications.notifications.some(note => note.subject === 'New tenant request: Leaking tap' && note.type === 'urgent'));
  const developerNotifications = await api('/api/notifications', 'GET', undefined, developer);
  assert.ok(developerNotifications.notifications.some(note => note.subject === 'New tenant request: Leaking tap'));
  const tenantNotifications = await api('/api/notifications', 'GET', undefined, tenant);
  await api(`/api/notifications/${ownerNotifications.notifications[0].id}`, 'PATCH', { read: true }, tenant, 404);
  const assignment = await api(`/api/requests/${submission.request.id}/assign`, 'POST', {
    agentId: agentInvite.agent.id,
    scheduledFor: '2026-11-11T10:00'
  }, owner);
  await api(`/api/work-orders/${assignment.workOrder.id}/status`, 'PATCH', { status: 'completed' }, agent, 409);
  const agentPhoto = await upload(
    `/api/files?purpose=request-photo&requestId=${submission.request.id}&name=repair-progress.png`,
    'image/png', requestPhoto, agent
  );
  assert.equal(agentPhoto.file.uploadedById, agentInvite.agent.id);
  await api(`/api/files/${agentPhoto.file.id}`, 'GET', undefined, agent);
  assert.ok((await api('/api/notifications', 'GET', undefined, agent)).notifications
    .some(note => note.subject === 'Work assigned: Leaking tap'));
  await api(`/api/work-orders/${assignment.workOrder.id}/status`, 'PATCH', { status: 'in_progress' }, agent);
  assert.equal((await api('/api/dashboard', 'GET', undefined, tenant)).requests[0].status, 'in_progress');
  await api(`/api/requests/${submission.request.id}/assign`, 'POST', {
    agentId: agentInvite.agent.id,
    scheduledFor: '2026-11-11T10:00'
  }, owner, 409);
  assert.ok((await api('/api/notifications', 'GET', undefined, owner)).notifications
    .some(note => note.subject === 'Request in progress: Leaking tap'));
  await api(`/api/work-orders/${assignment.workOrder.id}/status`, 'PATCH', { status: 'completed' }, agent);
  await api(`/api/work-orders/${assignment.workOrder.id}/status`, 'PATCH', { status: 'in_progress' }, agent, 409);
  assert.equal((await api('/api/dashboard', 'GET', undefined, tenant)).requests[0].status, 'resolved');
  assert.ok((await api('/api/notifications', 'GET', undefined, tenant)).notifications.length > tenantNotifications.notifications.length);
  await api('/api/notifications/read-all', 'PATCH', {}, tenant);
  assert.equal((await api('/api/notifications', 'GET', undefined, tenant)).unreadCount, 0);
  assert.equal((await api(`/api/units/resolve/${rotatedQrToken}`, 'GET', undefined, agent)).unit.id, unit.id);

  await api('/api/auth/change-password', 'POST', {
    currentPassword: 'IncorrectPassword123!',
    newPassword: 'NewTenantPassword456!'
  }, tenant, 403);
  await api('/api/auth/change-password', 'POST', {
    currentPassword: 'SecureTenantPass123!',
    newPassword: 'SecureTenantPass123!'
  }, tenant, 422);
  const passwordChange = await api('/api/auth/change-password', 'POST', {
    currentPassword: 'SecureTenantPass123!',
    newPassword: 'NewTenantPassword456!'
  }, tenant);
  assert.match(passwordChange.message, /Sign in again/);
  await api('/api/dashboard', 'GET', undefined, tenant, 401);
  await api('/api/auth/login', 'POST', {
    email: 'test-tenant@example.test',
    password: 'SecureTenantPass123!'
  }, undefined, 401);
  tenant = await login('test-tenant@example.test', 'NewTenantPassword456!');
  const savedStore = JSON.parse(await fs.readFile(storeFile, 'utf8'));
  const savedTenant = savedStore.users.find(user => user.email === 'test-tenant@example.test');
  assert.equal(savedTenant.status, 'active');
  assert.notEqual(savedTenant.passwordHash, 'NewTenantPassword456!');
  assert.match(savedTenant.passwordHash, /^[a-f0-9]+:[a-f0-9]+$/);
  assert.ok(savedStore.auditLogs.some(entry => entry.action === 'unit.qr_scanned' && entry.actorId === tenantInvite.tenant.id));

  const moveOut = await api('/api/move-outs', 'POST', {
    tenantId: tenantInvite.tenant.id,
    date: '2027-01-15',
    status: 'confirmed'
  }, owner, 201);
  await api(`/api/move-outs/${moveOut.moveOut.id}/status`, 'PATCH', { status: 'completed' }, owner);
  const ownerDashboard = await api('/api/dashboard', 'GET', undefined, owner);
  assert.equal(ownerDashboard.metrics.vacantUnits, 2);
  assert.equal(ownerDashboard.metrics.tenantSeatsUsed, 0);
  assert.equal(ownerDashboard.units.find(item => item.id === unit.id).status, 'vacant');
  assert.equal(ownerDashboard.leases.find(item => item.id === tenantDashboard.lease.id).status, 'ended');
  await api('/api/dashboard', 'GET', undefined, tenant, 401);

  const reset = await api('/api/auth/password-reset', 'POST', { email: 'test-owner@example.test' });
  assert.match(reset.message, /If that active account exists/);
});

test('production mode requires core secrets but permits unconfigured providers', () => {
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: '', PORT: '3199' },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing production configuration/);
  assert.doesNotMatch(result.stderr, /RESEND_API_KEY|AFRICASTALKING_API_KEY|DARAJA_CONSUMER_KEY/);
  assert.doesNotMatch(result.stderr, /Welcome123!/);
});

test('legacy admin accounts migrate to owner without losing portfolio access', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propertyflow-legacy-'));
  const port = await unusedPort();
  const storeFile = path.join(directory, 'store.json');
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = `${salt}:${crypto.scryptSync('LegacyOwnerPass123!', salt, 64).toString('hex')}`;
  await fs.writeFile(storeFile, JSON.stringify({
    users: [
      { id: 'legacy_admin', name: 'Legacy Manager', email: 'legacy-manager@example.test', role: 'admin', passwordHash, status: 'active', tenantSeatAllocation: 50, tenantSeatsUsed: 1, agentSeatAllocation: 2, ownerIds: ['legacy_owner'] },
      { id: 'legacy_owner', name: 'Linked Owner', email: 'linked-owner@example.test', role: 'owner', passwordHash, status: 'active', adminId: 'legacy_admin', tenantSeatAllocation: 20, tenantSeatsUsed: 1 },
      { id: 'legacy_tenant', name: 'Existing Tenant', email: 'legacy-tenant@example.test', role: 'tenant', passwordHash, status: 'active', ownerId: 'legacy_owner', propertyId: 'legacy_property', unit: 'A-1', rentAmount: 12000, leaseEnds: '2027-12-31', nextRentDue: '2026-12-01' }
    ],
    properties: [{ id: 'legacy_property', ownerId: 'legacy_owner', name: 'Legacy Court', address: '1 Old Road', totalUnits: 2, occupiedUnits: 1, monthlyRentExpected: 12000, collectedThisMonth: 0 }],
    units: [], leases: [], auditLogs: [], requests: [], workOrders: [], moveOuts: [],
    payments: [], notifications: [], sessions: {}, passwordResets: {}, loginFailures: {}
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), APP_BASE_URL: `http://127.0.0.1:${port}`, PROPERTYFLOW_STORE_FILE: storeFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`PropertyFlow exited before startup: ${serverOutput}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
    if (attempt === 39) throw new Error(`PropertyFlow did not start: ${serverOutput}`);
  }
  const loginResponse = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'legacy-manager@example.test', password: 'LegacyOwnerPass123!' })
  });
  assert.equal(loginResponse.status, 200);
  const { token } = await loginResponse.json();
  const dashboardResponse = await fetch(`${base}/api/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.role, 'owner');
  assert.ok(dashboard.properties.some(property => property.id === 'legacy_property'));
  assert.ok(dashboard.tenants.some(tenant => tenant.id === 'legacy_tenant'));
  const removedAdminEndpoint = await fetch(`${base}/api/admins`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(removedAdminEndpoint.status, 404);
  const savedStore = JSON.parse(await fs.readFile(storeFile, 'utf8'));
  assert.equal(savedStore.users.find(user => user.id === 'legacy_admin').role, 'owner');
  assert.ok(savedStore.properties.some(property => property.id === 'legacy_property'));
});
