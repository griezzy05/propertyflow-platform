/*
 * PropertyFlow API and static frontend server.
 * It intentionally uses only Node's built-in modules so it can run without npm install.
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_SSL = process.env.DATABASE_SSL !== 'false';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const STORE_FILE = process.env.PROPERTYFLOW_STORE_FILE
  ? path.resolve(process.env.PROPERTYFLOW_STORE_FILE)
  : path.join(ROOT, 'data', 'store.json');
const DATA_DIR = path.dirname(STORE_FILE);
const databaseTransactions = new AsyncLocalStorage();
const PASSWORD = 'Welcome123!';
let saveQueue = Promise.resolve();
let apiQueue = Promise.resolve();
let database;
const loginAttempts = new Map();

function assertProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const required = [
    'DATABASE_URL', 'APP_BASE_URL', 'SESSION_SECRET', 'BOOTSTRAP_DEVELOPER_NAME', 'BOOTSTRAP_DEVELOPER_EMAIL',
    'BOOTSTRAP_DEVELOPER_PASSWORD', 'RESEND_API_KEY', 'EMAIL_FROM',
    'AFRICASTALKING_USERNAME', 'AFRICASTALKING_API_KEY',
    'DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_SHORTCODE',
    'DARAJA_PASSKEY', 'DARAJA_CALLBACK_TOKEN'
  ];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  if (process.env.BOOTSTRAP_DEVELOPER_PASSWORD.length < 16) {
    throw new Error('BOOTSTRAP_DEVELOPER_PASSWORD must be at least 16 characters.');
  }
  if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
  const appUrl = new URL(APP_BASE_URL);
  if (appUrl.protocol !== 'https:') throw new Error('APP_BASE_URL must use HTTPS in production.');
}

function createPool() {
  if (!DATABASE_URL) return null;
  return new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_SSL ? { rejectUnauthorized: true } : false,
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000
  });
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function sessionHash(token) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'propertyflow-local-session-key').update(token).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function invitation() {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    invitationTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    invitationExpiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  };
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, savedHash] = stored.split(':');
  const computed = crypto.scryptSync(password, salt, 64).toString('hex');
  const saved = Buffer.from(savedHash, 'hex');
  const actual = Buffer.from(computed, 'hex');
  return saved.length === actual.length && crypto.timingSafeEqual(saved, actual);
}

function initialStore() {
  const passwordHash = hashPassword(PASSWORD);
  return {
    users: [
      { id: 'dev_1', name: 'Daniel Mwangi', email: 'developer@propertyflow.local', role: 'developer', passwordHash, status: 'active' },
      { id: 'admin_1', name: 'Grace Njeri', email: 'admin@propertyflow.local', role: 'admin', passwordHash, status: 'active', tenantSeatAllocation: 100, tenantSeatsUsed: 38, agentSeatAllocation: 2, ownerIds: ['owner_1'] },
      { id: 'owner_1', name: 'Amina Hassan', email: 'owner@propertyflow.local', role: 'owner', passwordHash, status: 'active', adminId: 'admin_1', tenantSeatAllocation: 40, tenantSeatsUsed: 38 },
      { id: 'tenant_1', name: 'Brian Otieno', email: 'tenant@propertyflow.local', role: 'tenant', passwordHash, status: 'active', ownerId: 'owner_1', propertyId: 'property_1', unit: 'B-12', leaseEnds: '2027-07-31', nextRentDue: '2026-11-12', rentAmount: 28000 },
      { id: 'agent_1', name: 'Mercy Wanjiku', email: 'agent@propertyflow.local', role: 'agent', passwordHash, status: 'active', ownerId: 'owner_1', agentType: 'primary' },
      { id: 'agent_2', name: 'David Omondi', email: 'backup.agent@propertyflow.local', role: 'agent', passwordHash, status: 'active', ownerId: 'owner_1', agentType: 'backup' }
    ],
    properties: [
      { id: 'property_1', ownerId: 'owner_1', name: 'Maple Court', address: 'Riverside Drive, Nairobi', totalUnits: 24, occupiedUnits: 22, monthlyRentExpected: 528000, collectedThisMonth: 496000 },
      { id: 'property_2', ownerId: 'owner_1', name: 'Garden View', address: 'Kilimani, Nairobi', totalUnits: 12, occupiedUnits: 11, monthlyRentExpected: 264000, collectedThisMonth: 232000 },
      { id: 'property_3', ownerId: 'owner_1', name: 'Parkside Houses', address: 'Lavington, Nairobi', totalUnits: 6, occupiedUnits: 5, monthlyRentExpected: 180000, collectedThisMonth: 168000 }
    ],
    units: [],
    leases: [],
    auditLogs: [],
    requests: [
      { id: 'request_1', ownerId: 'owner_1', tenantId: 'tenant_1', propertyId: 'property_1', title: 'Water leak beneath kitchen sink', details: 'Water is leaking under the kitchen sink.', type: 'Maintenance issue', priority: 'high', status: 'assigned', createdAt: '2026-11-10T07:10:00.000Z' },
      { id: 'request_2', ownerId: 'owner_1', tenantId: 'tenant_1', propertyId: 'property_1', title: 'Add lighting near the parking entrance', details: 'The parking entrance would be safer with brighter lighting.', type: 'Recommendation', priority: 'medium', status: 'under_review', createdAt: '2026-11-06T10:00:00.000Z' },
      { id: 'request_3', ownerId: 'owner_1', tenantId: 'tenant_1', propertyId: 'property_1', title: 'Bedroom window latch is loose', details: 'The latch does not close firmly.', type: 'Maintenance issue', priority: 'normal', status: 'received', createdAt: '2026-11-03T11:00:00.000Z' }
    ],
    workOrders: [
      { id: 'work_1', requestId: 'request_1', ownerId: 'owner_1', propertyId: 'property_1', unit: 'B-12', title: 'Water leak beneath kitchen sink', priority: 'high', assignedAgentId: 'agent_1', status: 'open', scheduledFor: '2026-11-10T10:30:00.000Z' },
      { id: 'work_2', requestId: 'request_3', ownerId: 'owner_1', propertyId: 'property_1', unit: 'C-03', title: 'Bedroom window latch', priority: 'medium', assignedAgentId: 'agent_1', status: 'open', scheduledFor: '2026-11-10T13:00:00.000Z' },
      { id: 'work_3', requestId: 'request_2', ownerId: 'owner_1', propertyId: 'property_2', unit: 'Common area', title: 'Parking entrance lighting survey', priority: 'medium', assignedAgentId: 'agent_1', status: 'scheduled', scheduledFor: '2026-11-10T16:30:00.000Z' }
    ],
    moveOuts: [
      { id: 'move_1', ownerId: 'owner_1', tenant: 'Nadia Wambui', unit: 'A-04', property: 'Maple Court', date: '2026-11-30', status: 'confirmed' },
      { id: 'move_2', ownerId: 'owner_1', tenant: 'Erick Kariuki', unit: 'C-09', property: 'Maple Court', date: '2026-12-05', status: 'lease_renewal' }
    ],
    payments: [],
    notifications: [],
    sessions: {},
    passwordResets: {},
    loginFailures: {}
  };
}

function emptyProductionStore() {
  return {
    users: [{
      id: id('developer'),
      name: process.env.BOOTSTRAP_DEVELOPER_NAME,
      email: process.env.BOOTSTRAP_DEVELOPER_EMAIL.trim().toLowerCase(),
      role: 'developer',
      passwordHash: hashPassword(process.env.BOOTSTRAP_DEVELOPER_PASSWORD),
      status: 'active'
    }],
    properties: [],
    units: [],
    leases: [],
    auditLogs: [],
    requests: [],
    workOrders: [],
    moveOuts: [],
    payments: [],
    sessions: {},
    passwordResets: {}
  };
}

function normalizeStore(value) {
  value.sessions ||= {};
  value.payments ||= [];
  value.notifications ||= [];
  value.passwordResets ||= {};
  value.loginFailures ||= {};
  value.units ||= [];
  value.leases ||= [];
  value.auditLogs ||= [];
  for (const tenant of value.users.filter(item => item.role === 'tenant' && item.propertyId && item.unit)) {
    const property = value.properties.find(item => item.id === tenant.propertyId);
    if (!property) continue;
    let unit = value.units.find(item => item.id === tenant.unitId)
      || value.units.find(item => item.propertyId === property.id && String(item.unitNumber || '').toLowerCase() === tenant.unit.toLowerCase());
    if (!unit) {
      const propertyCode = property.name.split(/\s+/).map(part => part[0] || '').join('').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PROP';
      const unitPart = tenant.unit.toUpperCase().replace(/[^A-Z0-9-]/g, '-') || 'UNIT';
      const token = crypto.randomBytes(32).toString('base64url');
      unit = {
        id: id('unit'),
        ownerId: tenant.ownerId,
        propertyId: property.id,
        unitNumber: tenant.unit,
        unitCode: `${propertyCode}-${unitPart}`,
        unitType: 'unspecified',
        bedrooms: null,
        askingRent: Number(tenant.rentAmount) || null,
        status: tenant.status === 'inactive' ? 'vacant' : 'occupied',
        currentLeaseId: null,
        qrTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        createdAt: new Date().toISOString()
      };
      value.units.push(unit);
    }
    tenant.unitId = unit.id;
    const lease = value.leases.find(item => item.tenantId === tenant.id && (
      tenant.status === 'inactive' ? item.status === 'ended' : ['pending', 'active'].includes(item.status)
    ));
    if (!lease) {
      const amount = Number(tenant.rentAmount) || 0;
      const leaseId = id('lease');
      const status = tenant.status === 'active' ? 'active' : tenant.status === 'invited' ? 'pending' : 'ended';
      value.leases.push({
        id: leaseId,
        tenantId: tenant.id,
        ownerId: tenant.ownerId,
        propertyId: property.id,
        unitId: unit.id,
        agreedRent: amount,
        depositAmount: 0,
        dueDay: Number(String(tenant.nextRentDue || '').slice(-2)) || 1,
        startDate: tenant.leaseStarts || new Date().toISOString().slice(0, 10),
        endDate: tenant.leaseEnds || null,
        status,
        rentHistory: [{ amount, effectiveFrom: tenant.leaseStarts || new Date().toISOString().slice(0, 10), changedBy: 'system:migration' }],
        createdAt: new Date().toISOString()
      });
      unit.currentLeaseId = status === 'ended' ? null : leaseId;
      if (status === 'ended') unit.status = 'vacant';
    } else {
      tenant.unitId = lease.unitId;
      unit.currentLeaseId = lease.status === 'ended' ? null : lease.id;
      unit.status = lease.status === 'ended' ? 'vacant' : 'occupied';
    }
  }
  return value;
}

function publicUnit(unit) {
  const { qrTokenHash, ...safeUnit } = unit;
  return safeUnit;
}

function createUnit(property, unitNumber, unitType = 'unspecified', bedrooms = null, askingRent = null) {
  const propertyCode = property.name.split(/\s+/).map(part => part[0] || '').join('').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PROP';
  const unitPart = unitNumber.toUpperCase().replace(/[^A-Z0-9-]/g, '-') || 'UNIT';
  let unitCode = `${propertyCode}-${unitPart}`;
  if (store.units.some(item => item.unitCode === unitCode)) {
    unitCode = `${unitCode}-${property.id.slice(-4).toUpperCase()}`;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  return {
    id: id('unit'),
    ownerId: property.ownerId,
    propertyId: property.id,
    unitNumber,
    unitCode,
    unitType,
    bedrooms,
    askingRent,
    status: 'vacant',
    currentLeaseId: null,
    qrTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    createdAt: new Date().toISOString()
  };
}

function rentAt(lease, date = new Date().toISOString().slice(0, 10)) {
  const applicable = (lease.rentHistory || [])
    .filter(change => change.effectiveFrom <= date)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return applicable.length ? applicable[applicable.length - 1].amount : lease.agreedRent;
}

function normalizeKenyanPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const normalized = digits.startsWith('0') ? `254${digits.slice(1)}` : digits.startsWith('7') || digits.startsWith('1') ? `254${digits}` : digits;
  return /^254[17]\d{8}$/.test(normalized) ? normalized : null;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function providerJson(url, options, providerName) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12_000) });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${providerName} returned an invalid response.`);
  }
  if (!response.ok) {
    const message = payload.message || payload.errorMessage || payload.error || 'Request failed.';
    throw new Error(`${providerName} delivery failed (${response.status}): ${message}`);
  }
  return payload;
}

async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return { status: 'not_configured' };
  await providerJson('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text })
  }, 'Email');
  return { status: 'sent' };
}

async function sendSms(phone, message) {
  const recipient = normalizeKenyanPhone(phone);
  if (!recipient) return { status: phone ? 'invalid_phone' : 'no_phone' };
  if (!process.env.AFRICASTALKING_USERNAME || !process.env.AFRICASTALKING_API_KEY) return { status: 'not_configured' };
  const sandbox = process.env.AFRICASTALKING_ENVIRONMENT === 'sandbox';
  const url = sandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  const body = new URLSearchParams({
    username: process.env.AFRICASTALKING_USERNAME,
    to: `+${recipient}`,
    message
  });
  if (process.env.AFRICASTALKING_SENDER_ID) body.set('from', process.env.AFRICASTALKING_SENDER_ID);
  const result = await providerJson(url, {
    method: 'POST',
    headers: {
      apiKey: process.env.AFRICASTALKING_API_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  }, 'SMS');
  const recipients = result.SMSMessageData?.Recipients || [];
  if (!recipients.some(item => item.status === 'Success')) throw new Error('SMS provider did not accept the message.');
  return { status: 'sent' };
}

async function deliverNotification(user, subject, text) {
  const deliveries = {};
  try {
    deliveries.email = await sendEmail(user.email, subject, text);
  } catch (cause) {
    console.error(`Email delivery failed for ${user.email}:`, cause.message);
    deliveries.email = { status: 'failed', message: cause.message };
  }
  if (user.phone) {
    try {
      deliveries.sms = await sendSms(user.phone, text);
    } catch (cause) {
      console.error(`SMS delivery failed for ${user.id}:`, cause.message);
      deliveries.sms = { status: 'failed', message: cause.message };
    }
  } else {
    deliveries.sms = { status: 'no_phone' };
  }
  return deliveries;
}

async function deliverAccountInvite(user, token) {
  const invitationUrl = new URL(`/?invite=${encodeURIComponent(token)}`, APP_BASE_URL).toString();
  const text = `Hello ${user.name}, activate your PropertyFlow ${user.role} account using this one-time link (expires in 48 hours): ${invitationUrl}`;
  const deliveries = await deliverNotification(user, 'Activate your PropertyFlow account', text);
  return { ...deliveries, invitationPath: `/?invite=${token}` };
}

async function notifyUser(user, subject, text, relatedId) {
  const delivery = await deliverNotification(user, subject, text);
  store.notifications.unshift({
    id: id('notification'),
    userId: user.id,
    subject,
    text,
    relatedId,
    delivery,
    createdAt: new Date().toISOString()
  });
  await saveStore(store);
  return delivery;
}

async function notifyUsers(users, subject, text, relatedId) {
  const uniqueUsers = [...new Map(users.filter(Boolean).map(user => [user.id, user])).values()];
  const results = [];
  for (const user of uniqueUsers) {
    results.push({ userId: user.id, ...await notifyUser(user, subject, text, relatedId) });
  }
  return results;
}

function darajaBaseUrl() {
  return process.env.DARAJA_ENVIRONMENT === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

async function darajaAccessToken() {
  const credentials = Buffer.from(`${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`).toString('base64');
  const result = await providerJson(`${darajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }
  }, 'M-Pesa');
  if (!result.access_token) throw new Error('M-Pesa did not return an access token.');
  return result.access_token;
}

function darajaTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

function nextRentDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  const targetMonth = month === 12 ? 1 : month + 1;
  const targetYear = month === 12 ? year + 1 : year;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

async function startMpesaPayment(user, phone) {
  const phoneNumber = normalizeKenyanPhone(phone || user.phone);
  if (!phoneNumber) throw new Error('Enter a valid Kenyan mobile number.');
  const dueDate = user.nextRentDue || new Date().toISOString().slice(0, 10);
  const lease = store.leases.find(item => item.tenantId === user.id && ['pending', 'active'].includes(item.status));
  const rentAmount = lease ? rentAt(lease, dueDate) : user.rentAmount;
  const timestamp = darajaTimestamp();
  const shortcode = process.env.DARAJA_SHORTCODE;
  const password = Buffer.from(`${shortcode}${process.env.DARAJA_PASSKEY}${timestamp}`).toString('base64');
  const callbackToken = process.env.DARAJA_CALLBACK_TOKEN;
  const callbackUrl = new URL(`/api/payments/mpesa/callback/${encodeURIComponent(callbackToken)}`, APP_BASE_URL).toString();
  const token = await darajaAccessToken();
  const result = await providerJson(`${darajaBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: process.env.DARAJA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
      Amount: Math.ceil(rentAmount),
      PartyA: phoneNumber,
      PartyB: shortcode,
      PhoneNumber: phoneNumber,
      CallBackURL: callbackUrl,
      AccountReference: `PF${user.id.replace(/[^A-Za-z0-9]/g, '').slice(-10)}`,
      TransactionDesc: `Rent ${user.unit}`
    })
  }, 'M-Pesa');
  if (result.ResponseCode !== '0' || !result.CheckoutRequestID) {
    throw new Error(result.ResponseDescription || 'M-Pesa did not accept the payment request.');
  }
  return { ...result, phoneNumber, amount: Math.ceil(rentAmount) };
}

async function loadDatabaseStore() {
  database = createPool();
  const migration = await fs.readFile(path.join(ROOT, 'database', 'migrations', '001_propertyflow_state.sql'), 'utf8');
  await database.query(migration);
  const { rows } = await database.query('SELECT state FROM propertyflow_state WHERE id = 1');
  if (rows.length) {
    const existing = normalizeStore(rows[0].state);
    if (process.env.NODE_ENV === 'production' && existing.users.some(user => user.email.endsWith('@propertyflow.local'))) {
      throw new Error('Production database contains demo accounts. Use a fresh database before deployment.');
    }
    return existing;
  }

  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO_DATA === 'true') {
    throw new Error('Demo data seeding is disabled in production.');
  }
  const seed = process.env.NODE_ENV === 'production' ? emptyProductionStore() : initialStore();
  await database.query(
    'INSERT INTO propertyflow_state (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING',
    [JSON.stringify(seed)]
  );
  const inserted = await database.query('SELECT state FROM propertyflow_state WHERE id = 1');
  return normalizeStore(inserted.rows[0].state);
}

async function loadStore() {
  if (DATABASE_URL) return loadDatabaseStore();
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production. Refusing to start with local JSON storage.');
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    return normalizeStore(JSON.parse(await fs.readFile(STORE_FILE, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const seed = normalizeStore(initialStore());
    await saveStore(seed);
    return seed;
  }
}

async function saveStore(store) {
  const client = databaseTransactions.getStore();
  if (client) {
    await client.query(
      'UPDATE propertyflow_state SET state = $1::jsonb, updated_at = now() WHERE id = 1',
      [JSON.stringify(store)]
    );
    return;
  }
  const write = saveQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tempFile = `${STORE_FILE}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(store, null, 2), 'utf8');
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(tempFile, STORE_FILE);
          break;
        } catch (cause) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(cause.code) || attempt >= 4) throw cause;
          await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    } catch (cause) {
      await fs.rm(tempFile, { force: true });
      throw cause;
    }
  });
  saveQueue = write.then(() => undefined, () => undefined);
  return write;
}

let store;

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
  });
  res.end(JSON.stringify(body));
}

function error(res, status, message) {
  send(res, status, { error: message });
}

function publicUser(user) {
  const { passwordHash, invitationTokenHash, invitationExpiresAt, ...safeUser } = user;
  return safeUser;
}

function deferredResponse(res) {
  let status = 200;
  let headers = {};
  let body = '';
  return {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(nextBody) {
      body = nextBody;
    },
    flush() {
      res.writeHead(status, headers);
      res.end(body);
    }
  };
}

function getToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function getCurrentUser(req) {
  const token = getToken(req);
  const key = token && sessionHash(token);
  const session = key && store.sessions[key];
  if (session && session.expiresAt <= Date.now()) {
    delete store.sessions[key];
    return null;
  }
  const userId = session?.userId;
  const user = userId ? store.users.find(item => item.id === userId && item.status === 'active') : null;
  return user || null;
}

async function handleDatabaseApi(req, res, url) {
  const client = await database.connect();
  const response = deferredResponse(res);
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT state FROM propertyflow_state WHERE id = 1 FOR UPDATE');
    if (!result.rows.length) throw new Error('Persistent application state has not been initialized.');
    store = normalizeStore(result.rows[0].state);
    await databaseTransactions.run(client, () => handleApi(req, response, url));
    await client.query('COMMIT');
    response.flush();
  } catch (cause) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Database rollback failed:', rollbackError); }
    console.error('Database-backed request failed:', cause);
    if (!res.headersSent) error(res, 500, 'The request could not be completed. Please try again.');
  } finally {
    client.release();
  }
}

function requireUser(req, res, roles) {
  const user = getCurrentUser(req);
  if (!user) {
    error(res, 401, 'Please sign in first.');
    return null;
  }
  if (roles && !roles.includes(user.role)) {
    error(res, 403, 'You do not have access to this action.');
    return null;
  }
  return user;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function ownerFor(user) {
  return store.users.find(candidate => candidate.id === user.ownerId);
}

function propertyFor(propertyId) {
  return store.properties.find(property => property.id === propertyId);
}

function visibleOwnerIds(user) {
  if (user.role === 'developer') return store.users.filter(item => item.role === 'owner').map(item => item.id);
  if (user.role === 'admin') return user.ownerIds || [];
  if (['owner', 'tenant', 'agent'].includes(user.role)) return [user.role === 'owner' ? user.id : user.ownerId];
  return [];
}

function requestView(request) {
  const tenant = store.users.find(user => user.id === request.tenantId);
  const property = propertyFor(request.propertyId);
  return { ...request, tenantName: tenant?.name || 'Tenant', unit: tenant?.unit || 'Common area', propertyName: property?.name || 'Property' };
}

function workOrderView(order) {
  const property = propertyFor(order.propertyId);
  const agent = store.users.find(user => user.id === order.assignedAgentId);
  return { ...order, propertyName: property?.name || 'Property', agentName: agent?.name || 'Unassigned' };
}

function dashboardFor(user) {
  if (user.role === 'developer') {
    const admins = store.users.filter(item => item.role === 'admin').map(admin => ({
      ...publicUser(admin), ownerCount: (admin.ownerIds || []).length
    }));
    return { role: user.role, profile: publicUser(user), admins, metrics: {
      activeAdmins: admins.filter(admin => admin.status === 'active').length,
      tenantSeatsUsed: admins.reduce((sum, admin) => sum + admin.tenantSeatsUsed, 0),
      tenantSeatAllocation: admins.reduce((sum, admin) => sum + admin.tenantSeatAllocation, 0),
      agentSeatsAssigned: admins.reduce((sum, admin) => sum + admin.agentSeatAllocation, 0)
    } };
  }
  if (user.role === 'admin') {
    const owners = store.users.filter(item => user.ownerIds.includes(item.id)).map(publicUser);
    const properties = store.properties.filter(item => user.ownerIds.includes(item.ownerId));
    const agents = store.users.filter(item => item.role === 'agent' && user.ownerIds.includes(item.ownerId)).map(publicUser);
    return { role: user.role, profile: publicUser(user), owners, agents, properties, requests: store.requests.filter(item => user.ownerIds.includes(item.ownerId)).map(requestView), metrics: {
      tenantSeatsUsed: user.tenantSeatsUsed, tenantSeatAllocation: user.tenantSeatAllocation, owners: owners.length, properties: properties.length,
      agentSeatsUsed: agents.length, agentSeatAllocation: user.agentSeatAllocation
    } };
  }
  if (user.role === 'owner') {
    const properties = store.properties.filter(item => item.ownerId === user.id);
    const requests = store.requests.filter(item => item.ownerId === user.id).map(requestView);
    const agents = store.users.filter(item => item.role === 'agent' && item.ownerId === user.id).map(publicUser);
    const payments = store.payments.filter(item => item.ownerId === user.id);
    const tenants = store.users.filter(item => item.role === 'tenant' && item.ownerId === user.id).map(tenant => ({
      ...publicUser(tenant),
      propertyName: propertyFor(tenant.propertyId)?.name || 'Property',
      unitCode: store.units.find(item => item.id === tenant.unitId)?.unitCode || tenant.unit
    }));
    const units = store.units.filter(item => item.ownerId === user.id).map(unit => {
      const currentLease = store.leases.find(lease => lease.id === unit.currentLeaseId);
      const tenant = currentLease && store.users.find(item => item.id === currentLease.tenantId);
      return {
        ...publicUnit(unit),
        propertyName: propertyFor(unit.propertyId)?.name || 'Property',
        tenantName: tenant?.name || null,
        nextRentDue: tenant?.nextRentDue || null,
        agreedRent: currentLease ? rentAt(currentLease, tenant?.nextRentDue) : null,
        paidAmount: tenant ? store.payments
          .filter(payment => payment.tenantId === tenant.id && payment.dueDate === tenant.nextRentDue && payment.status === 'paid')
          .reduce((sum, payment) => sum + payment.amount, 0) : 0,
        leaseStatus: currentLease?.status || null
      };
    });
    const leases = store.leases.filter(item => item.ownerId === user.id).map(lease => ({
      ...lease,
      tenantName: store.users.find(item => item.id === lease.tenantId)?.name || 'Tenant',
      unitCode: store.units.find(item => item.id === lease.unitId)?.unitCode || 'Unit',
      propertyName: propertyFor(lease.propertyId)?.name || 'Property',
      currentRent: rentAt(lease)
    }));
    return { role: user.role, profile: publicUser(user), properties, units, leases, tenants, requests, payments, moveOuts: store.moveOuts.filter(item => item.ownerId === user.id), agents, metrics: {
      totalUnits: properties.reduce((sum, property) => sum + property.totalUnits, 0),
      occupiedUnits: properties.reduce((sum, property) => sum + property.occupiedUnits, 0),
      vacantUnits: properties.reduce((sum, property) => sum + property.totalUnits - property.occupiedUnits, 0),
      expectedRent: properties.reduce((sum, property) => sum + property.monthlyRentExpected, 0),
      collectedRent: properties.reduce((sum, property) => sum + property.collectedThisMonth, 0),
      tenantSeatsUsed: user.tenantSeatsUsed,
      tenantSeatAllocation: user.tenantSeatAllocation
    } };
  }
  if (user.role === 'tenant') {
    const property = propertyFor(user.propertyId);
    const payments = store.payments.filter(item => item.tenantId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const lease = store.leases.find(item => item.tenantId === user.id && ['pending', 'active'].includes(item.status));
    const rentAmount = lease ? rentAt(lease, user.nextRentDue) : user.rentAmount;
    const currentBalance = Math.max(0, rentAmount - payments.filter(item => item.dueDate === user.nextRentDue && item.status === 'paid').reduce((total, item) => total + item.amount, 0));
    const notifications = store.notifications.filter(item => item.userId === user.id).slice(0, 10);
    const unit = store.units.find(item => item.id === user.unitId);
    return { role: user.role, profile: publicUser(user), property, unit: unit ? publicUnit(unit) : null, lease: lease ? { ...lease, currentRent: rentAmount } : null, payments, notifications, requests: store.requests.filter(item => item.tenantId === user.id).map(requestView), metrics: { currentBalance, nextRentDue: user.nextRentDue, rentAmount } };
  }
  if (user.role === 'agent') {
    const orders = store.workOrders.filter(item => item.assignedAgentId === user.id).map(workOrderView);
    const properties = store.properties.filter(item => item.ownerId === user.ownerId);
    return { role: user.role, profile: publicUser(user), properties, workOrders: orders, metrics: { assignedProperties: properties.length, openOrders: orders.filter(item => !['completed', 'closed'].includes(item.status)).length, completedThisWeek: orders.filter(order => order.status === 'completed').length } };
  }
  return { role: user.role, profile: publicUser(user) };
}

async function handleApi(req, res, url) {
  const method = req.method;
  if (method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok', service: 'propertyflow-api' });
  if (method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, {
      demoAccountsEnabled: process.env.NODE_ENV !== 'production',
      mpesaEnabled: Boolean(process.env.DARAJA_CONSUMER_KEY && process.env.DARAJA_CALLBACK_TOKEN),
      currency: 'KES'
    });
  }
  if (method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const attemptKey = `${req.socket.remoteAddress || 'unknown'}:${email}`;
    const attempts = loginAttempts.get(attemptKey) || [];
    const recentAttempts = attempts.filter(time => time > Date.now() - 15 * 60 * 1000);
    if (recentAttempts.length >= 10) return error(res, 429, 'Too many sign-in attempts. Try again in 15 minutes.');
    const user = store.users.find(item => item.email.toLowerCase() === email);
    if (!user || !verifyPassword(String(body.password || ''), user.passwordHash)) {
      recentAttempts.push(Date.now());
      loginAttempts.set(attemptKey, recentAttempts);
      return error(res, 401, 'Email or password is incorrect.');
    }
    if (user.status !== 'active') return error(res, 403, 'This account has not been activated yet.');
    loginAttempts.delete(attemptKey);
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sessionHash(token);
    for (const [hash, session] of Object.entries(store.sessions)) {
      if (session.expiresAt <= Date.now()) delete store.sessions[hash];
    }
    store.sessions[tokenHash] = { userId: user.id, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 };
    await saveStore(store);
    return send(res, 200, { token, user: publicUser(user) });
  }
  if (method === 'POST' && url.pathname === '/api/auth/activate') {
    const body = await readJson(req);
    const token = String(body.token || '');
    const password = String(body.password || '');
    if (password.length < 12) return error(res, 422, 'Choose a password with at least 12 characters.');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = store.users.find(item => item.invitationTokenHash === tokenHash);
    const expiresAt = user && Date.parse(user.invitationExpiresAt);
    if (!user || user.status !== 'invited' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return error(res, 422, 'This invitation is invalid or has expired. Ask your administrator for a new one.');
    }
    user.passwordHash = hashPassword(password);
    user.status = 'active';
    const lease = store.leases.find(item => item.tenantId === user.id && item.status === 'pending');
    if (lease) {
      lease.status = 'active';
      const unit = store.units.find(item => item.id === lease.unitId);
      if (unit) unit.status = 'occupied';
    }
    delete user.invitationTokenHash;
    delete user.invitationExpiresAt;
    await saveStore(store);
    return send(res, 200, { message: 'Your account is ready. Sign in with your new password.' });
  }
  if (method === 'POST' && url.pathname === '/api/auth/change-password') {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!verifyPassword(currentPassword, user.passwordHash)) return error(res, 403, 'Current password is incorrect.');
    if (newPassword.length < 12) return error(res, 422, 'Choose a password with at least 12 characters.');
    if (verifyPassword(newPassword, user.passwordHash)) return error(res, 422, 'Choose a password you have not used before.');
    user.passwordHash = hashPassword(newPassword);
    for (const [hash, session] of Object.entries(store.sessions)) {
      if (session.userId === user.id) delete store.sessions[hash];
    }
    await saveStore(store);
    return send(res, 200, { message: 'Password updated. Sign in again with your new password.' });
  }
  if (method === 'POST' && url.pathname === '/api/auth/password-reset') {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const user = store.users.find(item => item.email === email && item.status === 'active');
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      store.passwordResets[tokenHash] = { userId: user.id, expiresAt: Date.now() + 60 * 60 * 1000 };
      await saveStore(store);
      const resetUrl = new URL(`/?reset=${token}`, APP_BASE_URL).toString();
      await deliverNotification(user, 'Reset your PropertyFlow password', `Use this one-time link to reset your PropertyFlow password. It expires in one hour: ${resetUrl}`);
    }
    return send(res, 200, { message: 'If that active account exists, password reset instructions have been sent.' });
  }
  if (method === 'POST' && url.pathname === '/api/auth/password-reset/complete') {
    const body = await readJson(req);
    const password = String(body.password || '');
    if (password.length < 12) return error(res, 422, 'Choose a password with at least 12 characters.');
    const tokenHash = crypto.createHash('sha256').update(String(body.token || '')).digest('hex');
    const reset = store.passwordResets[tokenHash];
    if (!reset || reset.expiresAt <= Date.now()) return error(res, 422, 'This password reset link is invalid or expired.');
    const user = store.users.find(item => item.id === reset.userId && item.status === 'active');
    if (!user) return error(res, 422, 'This password reset link is invalid or expired.');
    user.passwordHash = hashPassword(password);
    delete store.passwordResets[tokenHash];
    for (const [hash, session] of Object.entries(store.sessions)) {
      if (session.userId === user.id) delete store.sessions[hash];
    }
    await saveStore(store);
    return send(res, 200, { message: 'Password updated. Sign in with your new password.' });
  }
  const invitationMatch = url.pathname.match(/^\/api\/invitations\/([^/]+)\/reissue$/);
  if (method === 'POST' && invitationMatch) {
    const user = requireUser(req, res);
    if (!user) return;
    const invitee = store.users.find(item => item.id === invitationMatch[1]);
    if (!invitee) return error(res, 404, 'Account not found.');
    const canReissue = (user.role === 'developer' && invitee.role === 'admin')
      || (user.role === 'admin' && (
        (invitee.role === 'owner' && invitee.adminId === user.id)
        || (invitee.role === 'agent' && user.ownerIds.includes(invitee.ownerId))
      ))
      || (user.role === 'owner' && invitee.role === 'tenant' && invitee.ownerId === user.id);
    if (!canReissue) return error(res, 403, 'You cannot reissue this account invitation.');
    if (invitee.status !== 'invited') return error(res, 409, 'This account has already been activated.');
    const invite = invitation();
    invitee.invitationTokenHash = invite.invitationTokenHash;
    invitee.invitationExpiresAt = invite.invitationExpiresAt;
    await saveStore(store);
    const delivery = await deliverAccountInvite(invitee, invite.token);
    return send(res, 200, delivery);
  }
  if (method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = getToken(req);
    if (token) {
      delete store.sessions[sessionHash(token)];
      await saveStore(store);
    }
    return send(res, 200, { ok: true });
  }
  if (method === 'GET' && url.pathname === '/api/auth/me') {
    const user = requireUser(req, res);
    if (user) return send(res, 200, { user: publicUser(user) });
    return;
  }
  if (method === 'GET' && url.pathname === '/api/dashboard') {
    const user = requireUser(req, res);
    if (user) return send(res, 200, dashboardFor(user));
    return;
  }
  if (method === 'GET' && url.pathname === '/api/payments') {
    const user = requireUser(req, res, ['developer', 'admin', 'owner', 'tenant']);
    if (!user) return;
    const ownerIds = visibleOwnerIds(user);
    const payments = store.payments.filter(payment => user.role === 'tenant'
      ? payment.tenantId === user.id
      : user.role === 'developer' || ownerIds.includes(payment.ownerId));
    return send(res, 200, { payments });
  }
  if (method === 'POST' && url.pathname === '/api/payments/mpesa/stk-push') {
    const user = requireUser(req, res, ['tenant']);
    if (!user) return;
    if (!process.env.DARAJA_CONSUMER_KEY || !process.env.DARAJA_CALLBACK_TOKEN) {
      return error(res, 503, 'M-Pesa payments are not configured yet.');
    }
    const body = await readJson(req);
    const phone = body.phone || user.phone;
    if (!normalizeKenyanPhone(phone)) return error(res, 422, 'Enter a valid Kenyan mobile number.');
    const dueDate = user.nextRentDue || new Date().toISOString().slice(0, 10);
    const duplicate = store.payments.find(payment => payment.tenantId === user.id && payment.dueDate === dueDate && payment.status === 'pending');
    if (duplicate) return error(res, 409, 'A payment request is already pending for this rent period.');
    try {
      const result = await startMpesaPayment(user, phone);
      const payment = {
        id: id('payment'),
        ownerId: user.ownerId,
        tenantId: user.id,
        propertyId: user.propertyId,
        amount: result.amount,
        currency: 'KES',
        method: 'mpesa',
        status: 'pending',
        dueDate,
        checkoutRequestId: result.CheckoutRequestID,
        merchantRequestId: result.MerchantRequestID,
        phoneNumber: result.phoneNumber,
        createdAt: new Date().toISOString()
      };
      store.payments.unshift(payment);
      await saveStore(store);
      return send(res, 202, { payment, message: result.CustomerMessage || 'Check your phone and enter your M-Pesa PIN to pay rent.' });
    } catch (cause) {
      console.error(`M-Pesa request failed for tenant ${user.id}:`, cause.message);
      return error(res, 502, cause.message || 'M-Pesa could not start the payment. Try again.');
    }
  }
  const mpesaCallbackMatch = url.pathname.match(/^\/api\/payments\/mpesa\/callback\/([^/]+)$/);
  if (method === 'POST' && mpesaCallbackMatch) {
    const expectedToken = process.env.DARAJA_CALLBACK_TOKEN || '';
    const receivedToken = decodeURIComponent(mpesaCallbackMatch[1]);
    if (!expectedToken || receivedToken.length !== expectedToken.length
      || !crypto.timingSafeEqual(Buffer.from(receivedToken), Buffer.from(expectedToken))) {
      return error(res, 404, 'Callback not found.');
    }
    const body = await readJson(req);
    const callback = body.Body?.stkCallback;
    if (!callback?.CheckoutRequestID || !callback?.MerchantRequestID) return error(res, 400, 'Invalid M-Pesa callback.');
    const payment = store.payments.find(item => item.checkoutRequestId === callback.CheckoutRequestID
      && item.merchantRequestId === callback.MerchantRequestID);
    if (!payment) return error(res, 404, 'Payment request not found.');
    const alreadyPaid = payment.status === 'paid';
    if (!alreadyPaid && callback.ResultCode === 0) {
      const items = callback.CallbackMetadata?.Item || [];
      const metadata = Object.fromEntries(items.map(item => [item.Name, item.Value]));
      const amount = Number(metadata.Amount);
      const phone = normalizeKenyanPhone(metadata.PhoneNumber);
      if (amount !== payment.amount || (phone && phone !== payment.phoneNumber)) {
        payment.status = 'review';
        payment.failureReason = 'The callback payment details did not match the request.';
      } else {
        payment.status = 'paid';
        payment.receiptNumber = String(metadata.MpesaReceiptNumber || '');
        payment.paidAt = new Date().toISOString();
        const property = propertyFor(payment.propertyId);
        if (property) property.collectedThisMonth += payment.amount;
        const tenant = store.users.find(item => item.id === payment.tenantId);
        if (tenant && tenant.nextRentDue === payment.dueDate) {
          tenant.nextRentDue = nextRentDate(payment.dueDate);
        }
      }
    } else if (payment.status === 'pending') {
      payment.status = 'failed';
      payment.failureReason = String(callback.ResultDesc || 'M-Pesa payment was not completed.').slice(0, 300);
    }
    payment.updatedAt = new Date().toISOString();
    await saveStore(store);
    const tenant = store.users.find(item => item.id === payment.tenantId);
    if (!alreadyPaid && payment.status === 'paid' && tenant) {
      await notifyUser(tenant, 'Rent payment received', `We received your KES ${payment.amount} rent payment. Receipt: ${payment.receiptNumber || 'pending'}.`, payment.id);
    }
    return send(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' });
  }
  if (method === 'GET' && url.pathname === '/api/admins') {
    const user = requireUser(req, res, ['developer']);
    if (user) return send(res, 200, { admins: store.users.filter(item => item.role === 'admin').map(publicUser) });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/admins') {
    const user = requireUser(req, res, ['developer']);
    if (!user) return;
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = body.phone ? normalizeKenyanPhone(body.phone) : null;
    const tenantSeatAllocation = Number(body.tenantSeatAllocation);
    const agentSeatAllocation = Number(body.agentSeatAllocation);
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return error(res, 422, 'Enter an admin name and valid work email.');
    if (body.phone && !phone) return error(res, 422, 'Enter a valid Kenyan mobile number.');
    if (store.users.some(item => item.email === email)) return error(res, 409, 'An account already uses that email.');
    if (!Number.isInteger(tenantSeatAllocation) || tenantSeatAllocation < 50) return error(res, 422, 'Each delegated admin must receive at least 50 tenant seats.');
    if (!Number.isInteger(agentSeatAllocation) || agentSeatAllocation < 0 || agentSeatAllocation > 2) return error(res, 422, 'Agent allocation must be between 0 and 2.');
    const invite = invitation();
    const admin = { id: id('admin'), name, email, phone, role: 'admin', passwordHash: '', status: 'invited', tenantSeatAllocation, tenantSeatsUsed: 0, agentSeatAllocation, ownerIds: [], invitationTokenHash: invite.invitationTokenHash, invitationExpiresAt: invite.invitationExpiresAt };
    store.users.push(admin);
    await saveStore(store);
    const delivery = await deliverAccountInvite(admin, invite.token);
    return send(res, 201, { admin: publicUser(admin), ...delivery, message: 'Admin created. Account activation instructions were sent where delivery is configured.' });
  }
  if (method === 'POST' && url.pathname === '/api/owners') {
    const user = requireUser(req, res, ['admin']);
    if (!user) return;
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = body.phone ? normalizeKenyanPhone(body.phone) : null;
    const tenantSeatAllocation = Number(body.tenantSeatAllocation);
    const allocatedSeats = store.users.filter(item => item.role === 'owner' && item.adminId === user.id)
      .reduce((total, owner) => total + owner.tenantSeatAllocation, 0);
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return error(res, 422, 'Enter an owner name and valid email.');
    if (body.phone && !phone) return error(res, 422, 'Enter a valid Kenyan mobile number.');
    if (store.users.some(item => item.email === email)) return error(res, 409, 'An account already uses that email.');
    if (!Number.isInteger(tenantSeatAllocation) || tenantSeatAllocation < 1) return error(res, 422, 'Owner tenant allocation must be at least 1.');
    if (allocatedSeats + tenantSeatAllocation > user.tenantSeatAllocation) return error(res, 422, 'This allocation exceeds your remaining tenant capacity.');
    const invite = invitation();
    const owner = { id: id('owner'), name, email, phone, role: 'owner', passwordHash: '', status: 'invited', adminId: user.id, tenantSeatAllocation, tenantSeatsUsed: 0, ownerIds: [], invitationTokenHash: invite.invitationTokenHash, invitationExpiresAt: invite.invitationExpiresAt };
    store.users.push(owner);
    user.ownerIds = [...(user.ownerIds || []), owner.id];
    await saveStore(store);
    const delivery = await deliverAccountInvite(owner, invite.token);
    return send(res, 201, { owner: publicUser(owner), ...delivery });
  }
  if (method === 'POST' && url.pathname === '/api/agents') {
    const user = requireUser(req, res, ['admin']);
    if (!user) return;
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = body.phone ? normalizeKenyanPhone(body.phone) : null;
    const owner = store.users.find(item => item.id === body.ownerId && item.role === 'owner' && user.ownerIds.includes(item.id));
    const agentType = String(body.agentType || '');
    const existingAgentCount = store.users.filter(item => item.role === 'agent' && user.ownerIds.includes(item.ownerId)).length;
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return error(res, 422, 'Enter an agent name and valid email.');
    if (body.phone && !phone) return error(res, 422, 'Enter a valid Kenyan mobile number.');
    if (!owner) return error(res, 422, 'Choose an owner in your workspace.');
    if (!['primary', 'backup'].includes(agentType)) return error(res, 422, 'Choose a primary or backup agent role.');
    if (store.users.some(item => item.email === email)) return error(res, 409, 'An account already uses that email.');
    if (existingAgentCount >= user.agentSeatAllocation) return error(res, 422, 'No agent seats are available in your allocation.');
    if (store.users.some(item => item.role === 'agent' && item.ownerId === owner.id && item.agentType === agentType)) return error(res, 409, `This owner already has a ${agentType} agent.`);
    const invite = invitation();
    const agent = { id: id('agent'), name, email, phone, role: 'agent', passwordHash: '', status: 'invited', ownerId: owner.id, agentType, invitationTokenHash: invite.invitationTokenHash, invitationExpiresAt: invite.invitationExpiresAt };
    store.users.push(agent);
    await saveStore(store);
    const delivery = await deliverAccountInvite(agent, invite.token);
    return send(res, 201, { agent: publicUser(agent), ...delivery });
  }
  const propertyUnitsMatch = url.pathname.match(/^\/api\/properties\/([^/]+)\/units$/);
  if (method === 'POST' && propertyUnitsMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const property = store.properties.find(item => item.id === propertyUnitsMatch[1] && item.ownerId === user.id);
    if (!property) return error(res, 404, 'Property not found.');
    const body = await readJson(req);
    const unitNumber = String(body.unitNumber || '').trim();
    const unitType = String(body.unitType || 'unspecified').trim().toLowerCase();
    const bedrooms = body.bedrooms === undefined || body.bedrooms === '' ? null : Number(body.bedrooms);
    const askingRent = body.askingRent === undefined || body.askingRent === '' ? null : Number(body.askingRent);
    if (!unitNumber || unitNumber.length > 40) return error(res, 422, 'Enter a unit number up to 40 characters.');
    if (!['apartment', 'house', 'studio', 'commercial', 'other', 'unspecified'].includes(unitType)) return error(res, 422, 'Choose a valid unit type.');
    if (bedrooms !== null && (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 20)) return error(res, 422, 'Bedrooms must be a whole number from 0 to 20.');
    if (askingRent !== null && (!Number.isFinite(askingRent) || askingRent <= 0)) return error(res, 422, 'Asking rent must be greater than zero.');
    if (store.units.some(item => item.propertyId === property.id && String(item.unitNumber || '').toLowerCase() === unitNumber.toLowerCase())) {
      return error(res, 409, 'This unit already exists in the property.');
    }
    if (store.units.filter(item => item.propertyId === property.id).length >= property.totalUnits) {
      return error(res, 422, 'All units configured for this property have been added.');
    }
    const unit = createUnit(property, unitNumber, unitType, bedrooms, askingRent);
    store.units.push(unit);
    store.auditLogs.unshift({ id: id('audit'), actorId: user.id, action: 'unit.created', subjectId: unit.id, createdAt: new Date().toISOString() });
    await saveStore(store);
    return send(res, 201, { unit: publicUnit(unit) });
  }
  const unitQrMatch = url.pathname.match(/^\/api\/units\/([^/]+)\/qr$/);
  if (method === 'POST' && unitQrMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const unit = store.units.find(item => item.id === unitQrMatch[1] && item.ownerId === user.id);
    if (!unit) return error(res, 404, 'Unit not found.');
    const qrToken = crypto.randomBytes(32).toString('base64url');
    const qrTokenHash = crypto.createHash('sha256').update(qrToken).digest('hex');
    const qrUrl = new URL(`/unit/${qrToken}`, APP_BASE_URL).toString();
    const qrCode = await QRCode.toDataURL(qrUrl, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 640,
      type: 'image/png'
    });
    unit.qrTokenHash = qrTokenHash;
    unit.qrGeneratedAt = new Date().toISOString();
    store.auditLogs.unshift({ id: id('audit'), actorId: user.id, action: 'unit.qr_rotated', subjectId: unit.id, createdAt: unit.qrGeneratedAt });
    await saveStore(store);
    return send(res, 200, { unit: publicUnit(unit), qrUrl, qrCode });
  }
  const unitResolveMatch = url.pathname.match(/^\/api\/units\/resolve\/([^/]+)$/);
  if (method === 'GET' && unitResolveMatch) {
    const user = requireUser(req, res, ['developer', 'admin', 'owner', 'tenant', 'agent']);
    if (!user) return;
    const qrTokenHash = crypto.createHash('sha256').update(unitResolveMatch[1]).digest('hex');
    const unit = store.units.find(item => item.qrTokenHash === qrTokenHash);
    if (!unit) return error(res, 404, 'This unit QR code is invalid or has been replaced.');
    const hasAccess = user.role === 'developer'
      || (user.role === 'owner' && unit.ownerId === user.id)
      || (user.role === 'admin' && (user.ownerIds || []).includes(unit.ownerId))
      || (user.role === 'tenant' && user.unitId === unit.id)
      || (user.role === 'agent' && user.ownerId === unit.ownerId && store.workOrders.some(order => {
        if (order.assignedAgentId !== user.id || order.propertyId !== unit.propertyId) return false;
        const request = store.requests.find(item => item.id === order.requestId);
        const tenant = request && store.users.find(item => item.id === request.tenantId);
        return order.unit === unit.unitNumber || tenant?.unitId === unit.id;
      }));
    if (!hasAccess) return error(res, 403, 'This QR code is not assigned to your account.');
    const property = propertyFor(unit.propertyId);
    store.auditLogs.unshift({ id: id('audit'), actorId: user.id, action: 'unit.qr_scanned', subjectId: unit.id, createdAt: new Date().toISOString() });
    await saveStore(store);
    const assignedWorkOrders = user.role === 'agent' ? store.workOrders.filter(order => {
      if (order.assignedAgentId !== user.id || order.propertyId !== unit.propertyId) return false;
      const request = store.requests.find(item => item.id === order.requestId);
      const tenant = request && store.users.find(item => item.id === request.tenantId);
      return order.unit === unit.unitNumber || tenant?.unitId === unit.id;
    }).map(workOrderView) : [];
    return send(res, 200, {
      unit: publicUnit(unit),
      property: property ? { id: property.id, name: property.name, address: property.address } : null,
      workOrders: assignedWorkOrders
    });
  }
  if (method === 'POST' && url.pathname === '/api/properties') {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const address = String(body.address || '').trim();
    const totalUnits = Number(body.totalUnits);
    if (!name || !address) return error(res, 422, 'Enter a property name and address.');
    if (!Number.isInteger(totalUnits) || totalUnits < 1) return error(res, 422, 'A property must have at least one unit.');
    const property = { id: id('property'), ownerId: user.id, name, address, totalUnits, occupiedUnits: 0, monthlyRentExpected: 0, collectedThisMonth: 0 };
    store.properties.push(property);
    await saveStore(store);
    return send(res, 201, { property });
  }
  if (method === 'POST' && url.pathname === '/api/tenants') {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const body = await readJson(req);
    if (user.tenantSeatsUsed >= user.tenantSeatAllocation) return error(res, 422, 'No tenant seats are available. Ask your property admin for more seats.');
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = body.phone ? normalizeKenyanPhone(body.phone) : null;
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return error(res, 422, 'Enter the tenant’s name and email.');
    if (body.phone && !phone) return error(res, 422, 'Enter a valid Kenyan mobile number.');
    if (store.users.some(item => item.email === email)) return error(res, 409, 'An account already uses that email.');
    let unit = body.unitId && store.units.find(item => item.id === body.unitId && item.ownerId === user.id);
    let unitCreated = false;
    const property = unit
      ? store.properties.find(item => item.id === unit.propertyId && item.ownerId === user.id)
      : store.properties.find(item => item.id === body.propertyId && item.ownerId === user.id);
    if (!property) return error(res, 422, 'Choose one of your properties.');
    const unitNumber = String(body.unit || '').trim();
    if (!unit && unitNumber) {
      unit = store.units.find(item => item.propertyId === property.id && String(item.unitNumber || '').toLowerCase() === unitNumber.toLowerCase());
      if (!unit) {
        if (property.occupiedUnits >= property.totalUnits) return error(res, 422, 'This property has no vacant units.');
        if (store.units.filter(item => item.propertyId === property.id).length >= property.totalUnits) {
          return error(res, 422, 'All units configured for this property have been added.');
        }
        unit = createUnit(property, unitNumber, 'unspecified', null, Number(body.rentAmount) || null);
        unitCreated = true;
      }
    }
    if (!unit || unit.propertyId !== property.id) return error(res, 422, 'Choose a vacant unit in this property.');
    if (unit.status !== 'vacant') return error(res, 409, 'This unit is already occupied or reserved.');
    const rentAmount = body.rentAmount === undefined || body.rentAmount === '' ? Number(unit.askingRent) : Number(body.rentAmount);
    const leaseEnds = String(body.leaseEnds || '');
    const nextRentDue = String(body.nextRentDue || '');
    const leaseStarts = String(body.leaseStartDate || new Date().toISOString().slice(0, 10));
    const depositAmount = body.depositAmount === undefined || body.depositAmount === '' ? 0 : Number(body.depositAmount);
    const dueDay = body.dueDay === undefined || body.dueDay === '' ? Number(nextRentDue.slice(-2)) : Number(body.dueDay);
    if (!Number.isFinite(rentAmount) || rentAmount <= 0) return error(res, 422, 'Enter a rent amount greater than zero.');
    if (!Number.isFinite(depositAmount) || depositAmount < 0) return error(res, 422, 'Enter a valid deposit amount.');
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return error(res, 422, 'Rent due day must be between 1 and 31.');
    if (!validDate(leaseStarts)) return error(res, 422, 'Enter a valid lease start date.');
    if (!validDate(leaseEnds) || !validDate(nextRentDue)) return error(res, 422, 'Enter valid lease end and next rent dates.');
    if (leaseEnds < leaseStarts) return error(res, 422, 'Lease end date must be on or after the start date.');
    if (property.occupiedUnits >= property.totalUnits) return error(res, 422, 'This property has no vacant units.');
    const invite = invitation();
    const tenant = { id: id('tenant'), name, email, phone, role: 'tenant', passwordHash: '', status: 'invited', ownerId: user.id, propertyId: property.id, unit: unit.unitNumber, unitId: unit.id, leaseStarts, leaseEnds, nextRentDue, rentAmount, invitationTokenHash: invite.invitationTokenHash, invitationExpiresAt: invite.invitationExpiresAt };
    const leaseId = id('lease');
    const lease = {
      id: leaseId,
      tenantId: tenant.id,
      ownerId: user.id,
      propertyId: property.id,
      unitId: unit.id,
      agreedRent: rentAmount,
      depositAmount,
      dueDay,
      startDate: leaseStarts,
      endDate: leaseEnds,
      status: 'pending',
      rentHistory: [{ amount: rentAmount, effectiveFrom: leaseStarts, changedBy: user.id }],
      createdAt: new Date().toISOString()
    };
    if (unitCreated) store.units.push(unit);
    store.users.push(tenant);
    store.leases.push(lease);
    unit.status = 'reserved';
    unit.currentLeaseId = leaseId;
    user.tenantSeatsUsed += 1;
    const admin = store.users.find(item => item.id === user.adminId);
    if (admin) admin.tenantSeatsUsed += 1;
    property.occupiedUnits += 1;
    property.monthlyRentExpected += rentAmount;
    store.auditLogs.unshift({ id: id('audit'), actorId: user.id, action: 'lease.created', subjectId: lease.id, createdAt: new Date().toISOString() });
    await saveStore(store);
    const delivery = await deliverAccountInvite(tenant, invite.token);
    return send(res, 201, { tenant: publicUser(tenant), ...delivery });
  }
  const leaseRentMatch = url.pathname.match(/^\/api\/leases\/([^/]+)\/rent$/);
  if (method === 'PATCH' && leaseRentMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const lease = store.leases.find(item => item.id === leaseRentMatch[1] && item.ownerId === user.id && ['pending', 'active'].includes(item.status));
    if (!lease) return error(res, 404, 'Active lease not found.');
    const body = await readJson(req);
    const amount = Number(body.rentAmount);
    const effectiveDate = String(body.effectiveDate || '');
    if (!Number.isFinite(amount) || amount <= 0) return error(res, 422, 'Enter a rent amount greater than zero.');
    if (!validDate(effectiveDate)) return error(res, 422, 'Enter a valid rent effective date.');
    if (effectiveDate < lease.startDate) return error(res, 422, 'Rent cannot change before the lease start date.');
    if (lease.rentHistory.some(change => change.effectiveFrom === effectiveDate)) return error(res, 409, 'A rent change already exists for this effective date.');
    if (store.payments.some(payment => payment.tenantId === lease.tenantId
      && ['paid', 'pending'].includes(payment.status) && payment.dueDate >= effectiveDate)) {
      return error(res, 409, 'A paid or pending payment exists for this date or a later date. Reconcile it before changing rent.');
    }
    const today = new Date().toISOString().slice(0, 10);
    const tenant = store.users.find(item => item.id === lease.tenantId);
    const property = propertyFor(lease.propertyId);
    const previousCurrentRent = rentAt(lease, today);
    lease.rentHistory.push({ amount, effectiveFrom: effectiveDate, changedBy: user.id });
    lease.rentHistory.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    const currentRent = rentAt(lease, today);
    lease.agreedRent = currentRent;
    if (tenant && effectiveDate <= today) tenant.rentAmount = currentRent;
    if (property && effectiveDate <= today) property.monthlyRentExpected += currentRent - previousCurrentRent;
    store.auditLogs.unshift({
      id: id('audit'),
      actorId: user.id,
      action: 'lease.rent_changed',
      subjectId: lease.id,
      effectiveDate,
      previousAmount: previousCurrentRent,
      newAmount: amount,
      createdAt: new Date().toISOString()
    });
    await saveStore(store);
    return send(res, 200, { lease: { ...lease, currentRent } });
  }
  if (method === 'POST' && url.pathname === '/api/move-outs') {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const body = await readJson(req);
    const tenant = store.users.find(item => item.id === body.tenantId && item.role === 'tenant' && item.ownerId === user.id && item.status === 'active');
    const date = String(body.date || '');
    const status = ['notice', 'confirmed', 'lease_renewal'].includes(body.status) ? body.status : 'notice';
    if (!tenant) return error(res, 422, 'Choose an active tenant account you manage.');
    if (!validDate(date)) return error(res, 422, 'Enter a valid expected move-out date.');
    if (store.moveOuts.some(item => item.tenantId === tenant.id && !['completed', 'cancelled'].includes(item.status))) {
      return error(res, 409, 'This tenant already has an open move-out record.');
    }
    const property = propertyFor(tenant.propertyId);
    const moveOut = { id: id('move'), ownerId: user.id, tenantId: tenant.id, tenant: tenant.name, unit: tenant.unit, property: property?.name || 'Property', date, status, createdAt: new Date().toISOString() };
    store.moveOuts.unshift(moveOut);
    await saveStore(store);
    return send(res, 201, { moveOut });
  }
  const moveOutMatch = url.pathname.match(/^\/api\/move-outs\/([^/]+)\/status$/);
  if (method === 'PATCH' && moveOutMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const moveOut = store.moveOuts.find(item => item.id === moveOutMatch[1] && item.ownerId === user.id);
    if (!moveOut) return error(res, 404, 'Move-out record not found.');
    const body = await readJson(req);
    if (!['completed', 'cancelled'].includes(body.status)) return error(res, 422, 'Choose completed or cancelled.');
    if (['completed', 'cancelled'].includes(moveOut.status)) return error(res, 409, 'This move-out record is already closed.');
    if (body.status === 'completed') {
      const tenant = store.users.find(item => item.id === moveOut.tenantId && item.ownerId === user.id && item.role === 'tenant' && item.status === 'active');
      if (!tenant) return error(res, 409, 'The tenant account is not active.');
      tenant.status = 'inactive';
      for (const [hash, session] of Object.entries(store.sessions)) {
        if (session.userId === tenant.id) delete store.sessions[hash];
      }
      user.tenantSeatsUsed = Math.max(0, user.tenantSeatsUsed - 1);
      const admin = store.users.find(item => item.id === user.adminId);
      if (admin) admin.tenantSeatsUsed = Math.max(0, admin.tenantSeatsUsed - 1);
      const property = propertyFor(tenant.propertyId);
      const lease = store.leases.find(item => item.tenantId === tenant.id && ['pending', 'active'].includes(item.status));
      const rentAmount = lease ? rentAt(lease, new Date().toISOString().slice(0, 10)) : tenant.rentAmount;
      if (lease) {
        lease.status = 'ended';
        lease.endedAt = new Date().toISOString();
      }
      const unit = store.units.find(item => item.id === tenant.unitId);
      if (unit) {
        unit.status = 'vacant';
        unit.currentLeaseId = null;
      }
      if (property) {
        property.occupiedUnits = Math.max(0, property.occupiedUnits - 1);
        property.monthlyRentExpected = Math.max(0, property.monthlyRentExpected - rentAmount);
      }
      store.auditLogs.unshift({ id: id('audit'), actorId: user.id, action: 'lease.ended', subjectId: lease?.id || tenant.id, createdAt: new Date().toISOString() });
    }
    moveOut.status = body.status;
    moveOut.closedAt = new Date().toISOString();
    await saveStore(store);
    return send(res, 200, { moveOut });
  }
  if (method === 'POST' && url.pathname === '/api/requests') {
    const user = requireUser(req, res, ['tenant']);
    if (!user) return;
    const body = await readJson(req);
    const title = String(body.title || '').trim();
    const details = String(body.details || '').trim();
    const allowedPriorities = ['normal', 'medium', 'high'];
    if (!title || !details) return error(res, 422, 'Add both a title and a description.');
    const request = { id: id('request'), ownerId: user.ownerId, tenantId: user.id, propertyId: user.propertyId, title, details, type: ['Maintenance issue', 'Safety concern', 'Recommendation'].includes(body.type) ? body.type : 'Maintenance issue', priority: allowedPriorities.includes(body.priority) ? body.priority : 'normal', status: 'received', createdAt: new Date().toISOString() };
    store.requests.unshift(request);
    await saveStore(store);
    const owner = store.users.find(item => item.id === user.ownerId);
    const agents = store.users.filter(item => item.role === 'agent' && item.ownerId === user.ownerId && item.status === 'active');
    const notifications = await notifyUsers([owner, ...agents], `New tenant request: ${title}`, `${user.name} reported ${title} at ${propertyFor(user.propertyId)?.name || 'their property'} · ${user.unit}. Priority: ${request.priority}.`, request.id);
    return send(res, 201, { request: requestView(request), notifications });
  }
  const assignRequestMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/assign$/);
  if (method === 'POST' && assignRequestMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const request = store.requests.find(item => item.id === assignRequestMatch[1] && item.ownerId === user.id);
    if (!request) return error(res, 404, 'Request not found.');
    if (request.status === 'resolved') return error(res, 422, 'Resolved requests cannot be assigned.');
    const body = await readJson(req);
    const agent = store.users.find(item => item.id === body.agentId && item.role === 'agent' && item.ownerId === user.id && item.status === 'active');
    if (!agent) return error(res, 422, 'Choose an active agent assigned to your properties.');
    const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : new Date();
    if (Number.isNaN(scheduledFor.getTime())) return error(res, 422, 'Enter a valid scheduled date and time.');
    let order = store.workOrders.find(item => item.requestId === request.id);
    if (order) {
      order.assignedAgentId = agent.id;
      order.scheduledFor = scheduledFor.toISOString();
      order.status = 'open';
      delete order.completedAt;
    } else {
      order = { id: id('work'), requestId: request.id, ownerId: user.id, propertyId: request.propertyId, unit: requestView(request).unit, title: request.title, priority: request.priority, assignedAgentId: agent.id, status: 'open', scheduledFor: scheduledFor.toISOString() };
      store.workOrders.push(order);
    }
    request.status = 'assigned';
    await saveStore(store);
    const tenant = store.users.find(item => item.id === request.tenantId);
    const notifications = await notifyUsers([agent, tenant], `Work assigned: ${request.title}`, `${request.title} has been assigned to ${agent.name}. Scheduled for ${scheduledFor.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}.`, request.id);
    return send(res, 200, { request: requestView(request), workOrder: workOrderView(order), notifications });
  }
  const workOrderMatch = url.pathname.match(/^\/api\/work-orders\/([^/]+)\/status$/);
  if (method === 'PATCH' && workOrderMatch) {
    const user = requireUser(req, res, ['agent']);
    if (!user) return;
    const order = store.workOrders.find(item => item.id === workOrderMatch[1] && item.assignedAgentId === user.id);
    if (!order) return error(res, 404, 'Work order not found.');
    const body = await readJson(req);
    if (!['in_progress', 'completed'].includes(body.status)) return error(res, 422, 'Invalid work-order status.');
    order.status = body.status;
    const request = store.requests.find(item => item.id === order.requestId);
    if (request) request.status = body.status === 'completed' ? 'resolved' : 'in_progress';
    if (body.status === 'completed') {
      order.completedAt = new Date().toISOString();
    }
    await saveStore(store);
    const tenant = request && store.users.find(item => item.id === request.tenantId);
    const owner = store.users.find(item => item.id === order.ownerId);
    const label = body.status === 'completed' ? 'resolved' : 'in progress';
    const notifications = await notifyUsers([tenant, owner], `Request ${label}: ${order.title}`, `${order.title} is now ${label}.`, request?.id || order.id);
    return send(res, 200, { workOrder: workOrderView(order), notifications });
  }
  return error(res, 404, 'Endpoint not found.');
}

const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
async function serveStatic(res, pathname) {
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); } catch { return error(res, 400, 'Invalid page path.'); }
  const requestPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = path.resolve(FRONTEND_DIR, `.${requestPath}`);
  const relativePath = path.relative(FRONTEND_DIR, filePath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return error(res, 403, 'Forbidden');
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
    });
    res.end(content);
  } catch (cause) {
    if (cause.code === 'ENOENT') return error(res, 404, 'Page not found.');
    return error(res, 500, 'Unable to read the requested file.');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (database) return await handleDatabaseApi(req, res, url);
      const task = apiQueue.then(() => handleApi(req, res, url));
      apiQueue = task.then(() => undefined, () => undefined);
      return await task;
    }
    const unitQrPageMatch = url.pathname.match(/^\/unit\/([A-Za-z0-9_-]{40,})$/);
    if (req.method === 'GET' && unitQrPageMatch) {
      const qrTokenHash = crypto.createHash('sha256').update(unitQrPageMatch[1]).digest('hex');
      if (!store.units.some(unit => unit.qrTokenHash === qrTokenHash)) return error(res, 404, 'This unit QR code is invalid or has been replaced.');
      res.writeHead(302, {
        Location: `/?unit=${encodeURIComponent(unitQrPageMatch[1])}`,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer'
      });
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 405, 'Method not allowed.');
    return await serveStatic(res, url.pathname);
  } catch (cause) {
    console.error(cause);
    return error(res, 500, 'Unexpected server error.');
  }
});

assertProductionConfig();
loadStore().then(loaded => {
  store = loaded;
  server.listen(PORT, '0.0.0.0', () => console.log(`PropertyFlow is running on port ${PORT}`));
}).catch(cause => {
  console.error('Could not start PropertyFlow:', cause);
  process.exit(1);
});

process.on('SIGTERM', () => {
  server.close(async () => {
    if (database) await database.end();
    process.exit(0);
  });
});
