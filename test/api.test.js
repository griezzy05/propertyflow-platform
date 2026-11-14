const assert = require('node:assert/strict');
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

test('role workflows, invitations, unit tracking, and payment configuration', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'propertyflow-api-'));
  const port = await unusedPort();
  const storeFile = path.join(directory, 'store.json');
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
      const response = await fetch(`${base}/api/health`);
      if (response.ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
    if (attempt === 39) throw new Error(`PropertyFlow did not start: ${serverOutput}`);
  }

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

  const developer = await login('developer@propertyflow.local', 'Welcome123!');
  await api('/api/admins', 'POST', {
    name: 'Underallocated Admin',
    email: 'underallocated@example.test',
    tenantSeatAllocation: 49,
    agentSeatAllocation: 1
  }, developer, 422);

  const adminInvite = await api('/api/admins', 'POST', {
    name: 'Test Admin',
    email: 'test-admin@example.test',
    tenantSeatAllocation: 55,
    agentSeatAllocation: 1
  }, developer, 201);
  assert.equal(adminInvite.email.status, 'not_configured');
  await activate(adminInvite.invitationPath, 'SecureAdminPass123!');
  const admin = await login('test-admin@example.test', 'SecureAdminPass123!');

  const seededOwner = await login('owner@propertyflow.local', 'Welcome123!');
  const seededOwnerDashboard = await api('/api/dashboard', 'GET', undefined, seededOwner);
  assert.ok(seededOwnerDashboard.units.some(unit => unit.unitNumber === 'B-12'));
  assert.ok(seededOwnerDashboard.leases.some(lease => lease.tenantName === 'Brian Otieno'));

  await api('/api/owners', 'POST', {
    name: 'Overallocated Owner',
    email: 'overallocated@example.test',
    tenantSeatAllocation: 56
  }, admin, 422);
  const ownerInvite = await api('/api/owners', 'POST', {
    name: 'Test Owner',
    email: 'test-owner@example.test',
    tenantSeatAllocation: 55
  }, admin, 201);
  await activate(ownerInvite.invitationPath, 'SecureOwnerPass123!');
  const owner = await login('test-owner@example.test', 'SecureOwnerPass123!');

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
  }, admin, 201);
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

  const tenantDashboard = await api('/api/dashboard', 'GET', undefined, tenant);
  assert.equal(tenantDashboard.metrics.currentBalance, 25000);
  assert.equal(tenantDashboard.property.occupiedUnits, 1);
  assert.equal(tenantDashboard.unit.id, unit.id);
  assert.equal(tenantDashboard.lease.depositAmount, 25000);
  assert.equal(tenantDashboard.lease.status, 'active');
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
  await api('/api/payments/mpesa/stk-push', 'POST', { phone: '0712345678' }, tenant, 503);
  await api('/api/properties', 'POST', { name: 'Forbidden', address: 'Nowhere', totalUnits: 1 }, tenant, 403);

  const submission = await api('/api/requests', 'POST', {
    title: 'Leaking tap',
    details: 'Tap is leaking in kitchen.',
    type: 'Maintenance issue',
    priority: 'high'
  }, tenant, 201);
  const assignment = await api(`/api/requests/${submission.request.id}/assign`, 'POST', {
    agentId: agentInvite.agent.id,
    scheduledFor: '2026-11-11T10:00'
  }, owner);
  await api(`/api/work-orders/${assignment.workOrder.id}/status`, 'PATCH', { status: 'in_progress' }, agent);
  assert.equal((await api('/api/dashboard', 'GET', undefined, tenant)).requests[0].status, 'in_progress');
  await api(`/api/work-orders/${assignment.workOrder.id}/status`, 'PATCH', { status: 'completed' }, agent);
  assert.equal((await api('/api/dashboard', 'GET', undefined, tenant)).requests[0].status, 'resolved');
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
