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
const {
  assertStorageConfigured,
  createPrivateDownloadUrl,
  deletePrivateObject,
  detectContentType,
  isStorageConfigured,
  newObjectKey,
  putPrivateObject,
  safeFileName
} = require('./storage');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const ROOT = __dirname;
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const PUBLIC_LEGAL_DIR = path.join(ROOT, 'docs', 'legal');
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_SSL = process.env.DATABASE_SSL !== 'false';
const DATABASE_SSL_REJECT_UNAUTHORIZED = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false';
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
    'BOOTSTRAP_DEVELOPER_PASSWORD'
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
    ssl: DATABASE_SSL ? { rejectUnauthorized: DATABASE_SSL_REJECT_UNAUTHORIZED } : false,
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
      { id: 'owner_1', name: 'Amina Hassan', email: 'owner@propertyflow.local', role: 'owner', passwordHash, status: 'active', tenantSeatAllocation: 100, tenantSeatsUsed: 1, agentSeatAllocation: 2 },
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
    platformPayments: [],
    ownerPaymentSettings: {},
    notifications: [],
    files: [],
    reminderSettings: {},
    reminderHistory: [],
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
    platformPayments: [],
    ownerPaymentSettings: {},
    files: [],
    reminderSettings: {},
    reminderHistory: [],
    sessions: {},
    passwordResets: {}
  };
}

function normalizeStore(value) {
  value.sessions ||= {};
  value.payments ||= [];
  value.platformPayments ||= [];
  value.ownerPaymentSettings ||= {};
  value.notifications ||= [];
  value.files ||= [];
  value.reminderSettings ||= {};
  value.reminderHistory ||= [];
  value.passwordResets ||= {};
  value.loginFailures ||= {};
  value.units ||= [];
  value.leases ||= [];
  value.auditLogs ||= [];
  for (const user of value.users) {
    if (user.role === 'admin') user.role = 'owner';
    if (user.role === 'owner') {
      user.ownerIds ||= [];
      user.tenantSeatsUsed ||= 0;
      user.tenantSeatAllocation ||= 50;
      user.agentSeatAllocation ??= 2;
    }
  }
  for (const notification of value.notifications) {
    notification.readAt ??= null;
    notification.type ||= 'general';
  }
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

function emptyOwnerPaymentSettings() {
  return {
    mpesaPhone: { enabled: false, phoneNumber: '', recipientName: '' },
    mpesaPaybill: { enabled: false, type: 'paybill', number: '', accountReference: '', recipientName: '' },
    mpesaBank: { enabled: false, bankName: '', paybillNumber: '', accountNumber: '', accountName: '' },
    bankTransfer: { enabled: false, bankName: '', accountName: '', accountNumber: '', branch: '' },
    cash: { enabled: false, instructions: '' }
  };
}

function ownerPaymentSettingsFor(ownerId) {
  return store.ownerPaymentSettings[ownerId] || emptyOwnerPaymentSettings();
}

function recordAudit(actor, action, subjectId, details = {}) {
  store.auditLogs.unshift({
    id: id('audit'),
    actorId: actor?.id || 'system',
    ownerId: details.ownerId || null,
    action,
    subjectId,
    details,
    createdAt: new Date().toISOString()
  });
  if (store.auditLogs.length > 10_000) store.auditLogs.length = 10_000;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvDocument(rows) {
  if (!rows.length) return 'No records\r\n';
  const headers = Object.keys(rows[0]);
  return [headers.map(csvCell).join(','), ...rows.map(row => headers.map(header => csvCell(row[header])).join(','))].join('\r\n');
}

function dateInNairobi(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function daysBetweenDates(first, second) {
  const [firstYear, firstMonth, firstDay] = first.split('-').map(Number);
  const [secondYear, secondMonth, secondDay] = second.split('-').map(Number);
  return Math.round((Date.UTC(firstYear, firstMonth - 1, firstDay) - Date.UTC(secondYear, secondMonth - 1, secondDay)) / 86_400_000);
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

async function notifyUser(user, subject, text, relatedId, options = {}) {
  const notification = {
    id: id('notification'),
    userId: user.id,
    subject,
    text,
    relatedId: relatedId || null,
    type: options.type || 'general',
    actionUrl: options.actionUrl || null,
    readAt: null,
    delivery: { email: { status: 'pending' }, sms: { status: user.phone ? 'pending' : 'no_phone' } },
    createdAt: new Date().toISOString()
  };
  store.notifications.unshift(notification);
  await saveStore(store);
  notification.delivery = options.deliver === false
    ? { email: { status: 'not_requested' }, sms: { status: user.phone ? 'not_requested' : 'no_phone' } }
    : await deliverNotification(user, subject, text);
  await saveStore(store);
  return { userId: user.id, ...notification.delivery, notificationId: notification.id };
}

async function notifyUsers(users, subject, text, relatedId, options = {}) {
  const uniqueUsers = [...new Map(users.filter(Boolean).map(user => [user.id, user])).values()];
  const results = [];
  for (const user of uniqueUsers) {
    results.push(await notifyUser(user, subject, text, relatedId, options));
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
  const destination = ownerPaymentSettingsFor(user.ownerId).mpesaPaybill;
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
      TransactionType: destination.type === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
      Amount: Math.ceil(rentAmount),
      PartyA: phoneNumber,
      PartyB: destination.number,
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

function sendCsv(res, filename, content) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(`\uFEFF${content}`);
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
    if (!res.headersSent) error(res, cause.status || 500, cause.status ? cause.message : 'The request could not be completed. Please try again.');
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

function readBinary(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > maxBytes) {
      req.resume();
      reject(Object.assign(new Error(`Files must be smaller than ${Math.floor(maxBytes / 1_000_000)} MB.`), { status: 413 }));
      return;
    }
    const chunks = [];
    let length = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      length += chunk.length;
      if (length > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error(`Files must be smaller than ${Math.floor(maxBytes / 1_000_000)} MB.`), { status: 413 }));
      resolve(Buffer.concat(chunks));
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
  if (user.role === 'owner') return [...new Set([user.id, ...(user.ownerIds || [])])];
  if (['tenant', 'agent'].includes(user.role)) return [user.ownerId];
  return [];
}

function ownerManagementRecipients(ownerId) {
  return store.users.filter(user => user.role === 'owner' && user.status === 'active'
    && (user.id === ownerId || (user.ownerIds || []).includes(ownerId)));
}

function ownerQuotaAccounts(ownerId) {
  const owner = store.users.find(user => user.id === ownerId && user.role === 'owner');
  if (!owner) return [];
  const parent = owner.adminId && store.users.find(user => user.id === owner.adminId && user.role === 'owner');
  return parent ? [owner, parent] : [owner];
}

function requestView(request) {
  const tenant = store.users.find(user => user.id === request.tenantId);
  const property = propertyFor(request.propertyId);
  return {
    ...request,
    attachments: store.files.filter(file => file.requestId === request.id).map(publicFile),
    tenantName: tenant?.name || 'Tenant',
    unit: tenant?.unit || 'Common area',
    propertyName: property?.name || 'Property'
  };
}

function publicFile(file) {
  const { objectKey, ...safeFile } = file;
  return safeFile;
}

function workOrderView(order) {
  const property = propertyFor(order.propertyId);
  const agent = store.users.find(user => user.id === order.assignedAgentId);
  return { ...order, propertyName: property?.name || 'Property', agentName: agent?.name || 'Unassigned' };
}

function userCanAccessFile(user, file) {
  if (user.role === 'developer') return true;
  if (file.purpose === 'request-photo') {
    const request = store.requests.find(item => item.id === file.requestId);
    if (!request) return false;
    if (user.role === 'tenant') return request.tenantId === user.id;
    if (user.role === 'owner') return visibleOwnerIds(user).includes(request.ownerId);
    return user.role === 'agent' && request.ownerId === user.ownerId
      && store.workOrders.some(order => order.requestId === request.id && order.assignedAgentId === user.id);
  }
  if (file.purpose === 'lease-document') {
    const lease = store.leases.find(item => item.id === file.leaseId);
    if (!lease) return false;
    if (user.role === 'owner') return visibleOwnerIds(user).includes(lease.ownerId);
    return user.role === 'tenant' && lease.tenantId === user.id;
  }
  return false;
}

function paymentScope(user, payment) {
  if (user.role === 'developer') return true;
  if (user.role === 'tenant') return payment.tenantId === user.id;
  return user.role === 'owner' && visibleOwnerIds(user).includes(payment.ownerId);
}

function rentForTenant(tenant, dueDate) {
  const lease = store.leases.find(item => item.tenantId === tenant.id && ['pending', 'active'].includes(item.status));
  return lease ? rentAt(lease, dueDate) : Number(tenant.rentAmount || 0);
}

function paidAmountForRent(tenantId, dueDate) {
  return store.payments.filter(payment => payment.tenantId === tenantId && payment.dueDate === dueDate && payment.status === 'paid')
    .reduce((total, payment) => total + Number(payment.amount || 0), 0);
}

function advanceRentDueIfCovered(tenant, dueDate) {
  if (tenant.nextRentDue !== dueDate || paidAmountForRent(tenant.id, dueDate) < rentForTenant(tenant, dueDate)) return false;
  tenant.nextRentDue = nextRentDate(dueDate);
  return true;
}

function rentReminderSettings(ownerId) {
  return store.reminderSettings[ownerId] || { enabled: true, days: [-3, 0, 3, 7], leaseDays: [30, 7, 0] };
}

function managementReportRows(type, user, startDate, endDate) {
  const ownerIds = user.role === 'developer'
    ? store.users.filter(item => item.role === 'owner').map(item => item.id)
    : visibleOwnerIds(user);
  const propertyName = propertyId => propertyFor(propertyId)?.name || 'Property';
  const tenantName = tenantId => store.users.find(item => item.id === tenantId)?.name || 'Tenant';
  const dateMatches = value => (!startDate || value >= startDate) && (!endDate || value <= endDate);

  if (type === 'rent') {
    return store.payments.filter(item => ownerIds.includes(item.ownerId) && dateMatches(item.paidAt?.slice(0, 10) || item.createdAt?.slice(0, 10) || ''))
      .map(item => ({
        property: propertyName(item.propertyId), tenant: tenantName(item.tenantId), dueDate: item.dueDate,
        paymentDate: item.paidAt || '', amount: item.amount, method: item.method, status: item.status,
        reference: item.reference || item.receiptNumber || ''
      }));
  }
  if (type === 'arrears') {
    const today = dateInNairobi();
    return store.users.filter(item => item.role === 'tenant' && item.status === 'active' && ownerIds.includes(item.ownerId))
      .map(tenant => {
        const dueDate = tenant.nextRentDue || '';
        const expected = dueDate ? rentForTenant(tenant, dueDate) : 0;
        const paid = dueDate ? paidAmountForRent(tenant.id, dueDate) : 0;
        return {
          property: propertyName(tenant.propertyId), tenant: tenant.name, unit: tenant.unit || '',
          dueDate, daysOverdue: dueDate ? Math.max(0, daysBetweenDates(today, dueDate)) : 0,
          expected, paid, balance: Math.max(0, expected - paid)
        };
      })
      .filter(item => item.balance > 0 && item.dueDate && item.dueDate <= today && dateMatches(item.dueDate));
  }
  if (type === 'occupancy') {
    return store.properties.filter(item => ownerIds.includes(item.ownerId)).map(item => ({
      property: item.name, address: item.address, totalUnits: item.totalUnits,
      occupiedUnits: item.occupiedUnits, vacantUnits: Math.max(0, item.totalUnits - item.occupiedUnits),
      occupancyPercent: item.totalUnits ? Math.round(item.occupiedUnits / item.totalUnits * 100) : 0
    }));
  }
  if (type === 'maintenance') {
    return store.requests.filter(item => ownerIds.includes(item.ownerId) && dateMatches(item.createdAt?.slice(0, 10) || ''))
      .map(item => {
        const order = store.workOrders.find(workOrder => workOrder.requestId === item.id);
        const agent = order && store.users.find(candidate => candidate.id === order.assignedAgentId);
        return {
          property: propertyName(item.propertyId), tenant: tenantName(item.tenantId),
          unit: requestView(item).unit, title: item.title, type: item.type, priority: item.priority,
          status: item.status, assignedAgent: agent?.name || '', createdAt: item.createdAt,
          scheduledFor: order?.scheduledFor || '', completedAt: order?.completedAt || ''
        };
      });
  }
  if (type === 'lease-expiry') {
    return store.leases.filter(item => ownerIds.includes(item.ownerId) && item.endDate && dateMatches(item.endDate))
      .map(item => ({
        property: propertyName(item.propertyId), tenant: tenantName(item.tenantId),
        unit: store.units.find(unit => unit.id === item.unitId)?.unitCode || '',
        leaseStart: item.startDate, leaseEnd: item.endDate, status: item.status,
        currentRent: rentAt(item, item.endDate)
      }));
  }
  return null;
}

async function runRentReminderSweep() {
  const today = dateInNairobi();
  const activeTenants = store.users.filter(user => user.role === 'tenant' && user.status === 'active' && user.nextRentDue);
  for (const tenant of activeTenants) {
    const settings = rentReminderSettings(tenant.ownerId);
    if (!settings.enabled || !Array.isArray(settings.days)) continue;
    const difference = daysBetweenDates(today, tenant.nextRentDue);
    if (!settings.days.includes(difference)) continue;
    if (paidAmountForRent(tenant.id, tenant.nextRentDue) >= rentForTenant(tenant, tenant.nextRentDue)) continue;
    const key = `${tenant.id}:${tenant.nextRentDue}:${difference}`;
    if (store.reminderHistory.some(entry => entry.key === key)) continue;
    const property = propertyFor(tenant.propertyId);
    const amount = rentForTenant(tenant, tenant.nextRentDue);
    const statusText = difference < 0
      ? `is due in ${Math.abs(difference)} day(s)`
      : difference === 0 ? 'is due today' : `is ${difference} day(s) overdue`;
    const results = await notifyUsers(
      [tenant, ...ownerManagementRecipients(tenant.ownerId)],
      difference > 0 ? 'Rent payment overdue' : 'Rent reminder',
      `${property?.name || 'Your property'}: KES ${amount} rent for ${tenant.nextRentDue} ${statusText}.`,
      tenant.id,
      { type: 'payment', actionUrl: '/?section=payments' }
    );
    store.reminderHistory.unshift({
      key,
      ownerId: tenant.ownerId,
      tenantId: tenant.id,
      dueDate: tenant.nextRentDue,
      daysFromDue: difference,
      notificationIds: results.map(item => item.notificationId),
      delivery: results,
      createdAt: new Date().toISOString()
    });
    if (store.reminderHistory.length > 10_000) store.reminderHistory.length = 10_000;
    await saveStore(store);
  }

  for (const lease of store.leases.filter(item => item.status === 'active' && item.endDate)) {
    const settings = rentReminderSettings(lease.ownerId);
    if (!settings.enabled || !Array.isArray(settings.leaseDays)) continue;
    const daysUntilEnd = daysBetweenDates(lease.endDate, today);
    if (!settings.leaseDays.includes(daysUntilEnd)) continue;
    const key = `lease:${lease.id}:${daysUntilEnd}`;
    if (store.reminderHistory.some(entry => entry.key === key)) continue;
    const tenant = store.users.find(user => user.id === lease.tenantId && user.status === 'active');
    const recipients = [tenant, ...ownerManagementRecipients(lease.ownerId)].filter(Boolean);
    const label = daysUntilEnd === 0 ? 'ends today' : `ends in ${daysUntilEnd} day(s)`;
    const results = await notifyUsers(recipients, 'Lease expiry reminder',
      `The lease for ${tenant?.name || 'your tenant'} at ${propertyFor(lease.propertyId)?.name || 'your property'} ${label} (${lease.endDate}).`,
      lease.id, { type: 'lease', actionUrl: '/?section=tenants' });
    store.reminderHistory.unshift({
      key, ownerId: lease.ownerId, tenantId: lease.tenantId, leaseId: lease.id,
      daysFromDue: -daysUntilEnd, notificationIds: results.map(item => item.notificationId),
      delivery: results, createdAt: new Date().toISOString()
    });
    if (store.reminderHistory.length > 10_000) store.reminderHistory.length = 10_000;
    await saveStore(store);
  }
}

function dashboardFor(user) {
  if (user.role === 'developer') {
    const owners = store.users.filter(item => item.role === 'owner' && !item.adminId).map(owner => ({
      ...publicUser(owner), managedOwnerCount: (owner.ownerIds || []).length,
      agentSeatsUsed: store.users.filter(agent => agent.role === 'agent'
        && [owner.id, ...(owner.ownerIds || [])].includes(agent.ownerId)).length
    }));
    const platformPayments = store.platformPayments
      .map(payment => ({
        ...payment,
        ownerName: store.users.find(item => item.id === payment.ownerId)?.name || 'Unknown owner'
      }))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    return { role: user.role, profile: publicUser(user), owners, platformPayments, metrics: {
      activeOwners: owners.filter(owner => owner.status === 'active').length,
      tenantSeatsUsed: owners.reduce((sum, owner) => sum + owner.tenantSeatsUsed, 0),
      tenantSeatAllocation: owners.reduce((sum, owner) => sum + owner.tenantSeatAllocation, 0),
      agentSeatsAssigned: owners.reduce((sum, owner) => sum + owner.agentSeatsUsed, 0),
      platformRevenueReceived: platformPayments.filter(payment => payment.status === 'confirmed')
        .reduce((sum, payment) => sum + payment.amount, 0),
      platformPaymentsPending: platformPayments.filter(payment => payment.status === 'pending')
        .reduce((sum, payment) => sum + payment.amount, 0)
    } };
  }
  if (user.role === 'owner') {
    const ownerIds = visibleOwnerIds(user);
    const owners = store.users.filter(item => ownerIds.includes(item.id) && item.role === 'owner').map(publicUser);
    const properties = store.properties.filter(item => ownerIds.includes(item.ownerId));
    const requests = store.requests.filter(item => ownerIds.includes(item.ownerId)).map(requestView);
    const agents = store.users.filter(item => item.role === 'agent' && ownerIds.includes(item.ownerId)).map(publicUser);
    const payments = store.payments.filter(item => ownerIds.includes(item.ownerId));
    const tenants = store.users.filter(item => item.role === 'tenant' && ownerIds.includes(item.ownerId)).map(tenant => ({
      ...publicUser(tenant),
      propertyName: propertyFor(tenant.propertyId)?.name || 'Property',
      unitCode: store.units.find(item => item.id === tenant.unitId)?.unitCode || tenant.unit
    }));
    const units = store.units.filter(item => ownerIds.includes(item.ownerId)).map(unit => {
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
    const leases = store.leases.filter(item => ownerIds.includes(item.ownerId)).map(lease => ({
      ...lease,
      attachments: store.files.filter(file => file.leaseId === lease.id).map(publicFile),
      tenantName: store.users.find(item => item.id === lease.tenantId)?.name || 'Tenant',
      unitCode: store.units.find(item => item.id === lease.unitId)?.unitCode || 'Unit',
      propertyName: propertyFor(lease.propertyId)?.name || 'Property',
      currentRent: rentAt(lease)
    }));
    const ownerSeatUsage = user.tenantSeatsUsed;
    return { role: user.role, profile: publicUser(user), owners, properties, units, leases, tenants, requests, payments, paymentSettings: ownerPaymentSettingsFor(user.id), moveOuts: store.moveOuts.filter(item => ownerIds.includes(item.ownerId)), agents, metrics: {
      totalUnits: properties.reduce((sum, property) => sum + property.totalUnits, 0),
      occupiedUnits: properties.reduce((sum, property) => sum + property.occupiedUnits, 0),
      vacantUnits: properties.reduce((sum, property) => sum + property.totalUnits - property.occupiedUnits, 0),
      expectedRent: properties.reduce((sum, property) => sum + property.monthlyRentExpected, 0),
      collectedRent: properties.reduce((sum, property) => sum + property.collectedThisMonth, 0),
      tenantSeatsUsed: ownerSeatUsage,
      tenantSeatAllocation: user.tenantSeatAllocation,
      agentSeatsUsed: agents.length,
      agentSeatAllocation: user.agentSeatAllocation
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
    return {
      role: user.role, profile: publicUser(user), property, unit: unit ? publicUnit(unit) : null,
      lease: lease ? {
        ...lease,
        attachments: store.files.filter(file => file.leaseId === lease.id).map(publicFile),
        currentRent: rentAmount
      } : null,
      payments, paymentSettings: ownerPaymentSettingsFor(user.ownerId), notifications, requests: store.requests.filter(item => item.tenantId === user.id).map(requestView),
      metrics: { currentBalance, nextRentDue: user.nextRentDue, rentAmount }
    };
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
      mpesaEnabled: Boolean(process.env.DARAJA_CONSUMER_KEY && process.env.DARAJA_CALLBACK_TOKEN && process.env.DARAJA_OWNER_ID),
      mpesaEnvironment: process.env.DARAJA_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
      mpesaShortcode: process.env.DARAJA_SHORTCODE || null,
      mpesaRecipientName: process.env.DARAJA_RECIPIENT_NAME || null,
      fileStorageEnabled: isStorageConfigured(),
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
      return error(res, 422, 'This invitation is invalid or has expired. Ask your property owner for a new one.');
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
    await notifyUser(user, 'Welcome to PropertyFlow', 'Your account is active. Updates and important activity for your role will appear in Notifications.', user.id, { type: 'account', deliver: false });
    const inviter = store.users.find(item => item.id === user.invitedById);
    if (inviter) await notifyUser(inviter, 'Account activated', `${user.name} has activated their ${user.role} account.`, user.id, { type: 'account' });
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
    const ownerIds = visibleOwnerIds(user);
    const canReissue = (user.role === 'developer' && invitee.role === 'owner')
      || (user.role === 'owner' && (
        (invitee.role === 'owner' && ownerIds.includes(invitee.id))
        || (['tenant', 'agent'].includes(invitee.role) && ownerIds.includes(invitee.ownerId))
      ));
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
    if (!user) return;
    const ownerId = url.searchParams.get('ownerId');
    if (ownerId) {
      if (user.role !== 'developer') return error(res, 403, 'Only the developer can inspect another owner workspace.');
      const owner = store.users.find(item => item.id === ownerId && item.role === 'owner' && !item.adminId);
      if (!owner) return error(res, 404, 'Owner account not found.');
      return send(res, 200, { ...dashboardFor(owner), readOnlyDeveloperView: true });
    }
    return send(res, 200, dashboardFor(user));
    return;
  }
  if (method === 'PATCH' && url.pathname === '/api/payment-settings') {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const body = await readJson(req);
    const mpesaPhoneInput = body.mpesaPhone || {};
    const mpesaPaybillInput = body.mpesaPaybill || {};
    const mpesaBankInput = body.mpesaBank || {};
    const bankTransferInput = body.bankTransfer || {};
    const cashInput = body.cash || {};
    const mpesaPhone = normalizeKenyanPhone(mpesaPhoneInput.phoneNumber);
    const mpesaPaybillType = String(mpesaPaybillInput.type || '');
    const mpesaPaybillNumber = String(mpesaPaybillInput.number || '').trim();
    const mpesaPaybillReference = String(mpesaPaybillInput.accountReference || '').trim().slice(0, 80);
    const mpesaBankPaybill = String(mpesaBankInput.paybillNumber || '').trim();
    const mpesaBankAccount = String(mpesaBankInput.accountNumber || '').trim().slice(0, 80);
    const bankAccount = String(bankTransferInput.accountNumber || '').trim().slice(0, 80);
    const settings = {
      mpesaPhone: {
        enabled: mpesaPhoneInput.enabled === true,
        phoneNumber: mpesaPhone ? `+${mpesaPhone}` : '',
        recipientName: String(mpesaPhoneInput.recipientName || '').trim().slice(0, 100)
      },
      mpesaPaybill: {
        enabled: mpesaPaybillInput.enabled === true,
        type: mpesaPaybillType,
        number: mpesaPaybillNumber,
        accountReference: mpesaPaybillReference,
        recipientName: String(mpesaPaybillInput.recipientName || '').trim().slice(0, 100)
      },
      mpesaBank: {
        enabled: mpesaBankInput.enabled === true,
        bankName: String(mpesaBankInput.bankName || '').trim().slice(0, 100),
        paybillNumber: mpesaBankPaybill,
        accountNumber: mpesaBankAccount,
        accountName: String(mpesaBankInput.accountName || '').trim().slice(0, 100)
      },
      bankTransfer: {
        enabled: bankTransferInput.enabled === true,
        bankName: String(bankTransferInput.bankName || '').trim().slice(0, 100),
        accountName: String(bankTransferInput.accountName || '').trim().slice(0, 100),
        accountNumber: bankAccount,
        branch: String(bankTransferInput.branch || '').trim().slice(0, 100)
      },
      cash: {
        enabled: cashInput.enabled === true,
        instructions: String(cashInput.instructions || '').trim().slice(0, 500)
      }
    };
    if (settings.mpesaPhone.enabled && (!mpesaPhone || !settings.mpesaPhone.recipientName)) {
      return error(res, 422, 'Enter a valid M-Pesa phone number and recipient name.');
    }
    if (settings.mpesaPaybill.enabled && (!['paybill', 'till'].includes(mpesaPaybillType)
      || !/^\d{5,12}$/.test(mpesaPaybillNumber) || !settings.mpesaPaybill.recipientName
      || (mpesaPaybillType === 'paybill' && !mpesaPaybillReference))) {
      return error(res, 422, 'Enter the recipient, valid Paybill/Till number, and Paybill account reference if required.');
    }
    if (settings.mpesaBank.enabled && (!settings.mpesaBank.bankName || !/^\d{5,12}$/.test(mpesaBankPaybill)
      || !mpesaBankAccount || !settings.mpesaBank.accountName)) {
      return error(res, 422, 'Enter the bank name, valid M-Pesa Paybill, bank account number, and account name.');
    }
    if (settings.bankTransfer.enabled && (!settings.bankTransfer.bankName
      || !settings.bankTransfer.accountName || !bankAccount)) {
      return error(res, 422, 'Enter the bank name, account name, and bank account number.');
    }
    if (settings.cash.enabled && !settings.cash.instructions) {
      return error(res, 422, 'Enter instructions for handing cash to the owner or agent.');
    }
    const enabledMethods = Object.entries(settings).filter(([, value]) => value.enabled).map(([key]) => key);
    store.ownerPaymentSettings[user.id] = settings;
    recordAudit(user, 'payment_settings.updated', user.id, { ownerId: user.id, enabledMethods });
    await saveStore(store);
    return send(res, 200, { paymentSettings: settings });
  }
  if (method === 'POST' && url.pathname === '/api/platform-payments') {
    const user = requireUser(req, res, ['developer']);
    if (!user) return;
    const body = await readJson(req);
    const owner = store.users.find(item => item.id === body.ownerId && item.role === 'owner');
    const amount = Number(body.amount);
    const methodName = String(body.method || '');
    const reference = String(body.reference || '').trim().slice(0, 100);
    const paidOn = String(body.paidOn || '');
    if (!owner) return error(res, 422, 'Choose a property owner account.');
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) {
      return error(res, 422, 'Enter a valid payment amount.');
    }
    if (!['mpesa', 'bank', 'cash', 'other'].includes(methodName)) {
      return error(res, 422, 'Choose a valid payment method.');
    }
    if (!reference) return error(res, 422, 'Enter the payment receipt or transaction reference.');
    if (!validDate(paidOn)) return error(res, 422, 'Enter a valid payment date.');
    if (store.platformPayments.some(item => item.reference.toLowerCase() === reference.toLowerCase())) {
      return error(res, 409, 'That platform payment reference has already been recorded.');
    }
    const payment = {
      id: id('platform_payment'),
      ownerId: owner.id,
      amount,
      currency: 'KES',
      method: methodName,
      reference,
      paidOn,
      status: 'pending',
      recordedAt: new Date().toISOString(),
      recordedBy: user.id
    };
    store.platformPayments.unshift(payment);
    recordAudit(user, 'platform_payment.recorded', payment.id, {
      ownerId: owner.id, amount, method: methodName, reference, paidOn
    });
    await saveStore(store);
    return send(res, 201, { payment: { ...payment, ownerName: owner.name } });
  }
  const platformPaymentReviewMatch = url.pathname.match(/^\/api\/platform-payments\/([^/]+)\/review$/);
  if (method === 'PATCH' && platformPaymentReviewMatch) {
    const user = requireUser(req, res, ['developer']);
    if (!user) return;
    const payment = store.platformPayments.find(item => item.id === platformPaymentReviewMatch[1]);
    if (!payment) return error(res, 404, 'Platform payment not found.');
    if (payment.status !== 'pending') return error(res, 409, 'Only unconfirmed platform payments can be reviewed.');
    const body = await readJson(req);
    if (!['confirm', 'reject'].includes(body.action)) return error(res, 422, 'Choose confirm or reject.');
    payment.status = body.action === 'confirm' ? 'confirmed' : 'rejected';
    payment.reviewedAt = new Date().toISOString();
    payment.reviewedBy = user.id;
    if (body.action === 'confirm') payment.confirmedAt = payment.reviewedAt;
    recordAudit(user, `platform_payment.${payment.status}`, payment.id, {
      ownerId: payment.ownerId, amount: payment.amount, reference: payment.reference
    });
    await saveStore(store);
    return send(res, 200, { payment });
  }
  if (method === 'GET' && url.pathname === '/api/notifications') {
    const user = requireUser(req, res);
    if (!user) return;
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
    const notifications = store.notifications.filter(item => item.userId === user.id).slice(0, limit);
    return send(res, 200, {
      notifications,
      unreadCount: store.notifications.filter(item => item.userId === user.id && !item.readAt).length
    });
  }
  if (method === 'PATCH' && url.pathname === '/api/notifications/read-all') {
    const user = requireUser(req, res);
    if (!user) return;
    const readAt = new Date().toISOString();
    for (const notification of store.notifications) {
      if (notification.userId === user.id && !notification.readAt) notification.readAt = readAt;
    }
    await saveStore(store);
    return send(res, 200, { unreadCount: 0 });
  }
  const notificationMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)$/);
  if (method === 'PATCH' && notificationMatch) {
    const user = requireUser(req, res);
    if (!user) return;
    const notification = store.notifications.find(item => item.id === notificationMatch[1] && item.userId === user.id);
    if (!notification) return error(res, 404, 'Notification not found.');
    const body = await readJson(req);
    if (typeof body.read !== 'boolean') return error(res, 422, 'Choose whether the notification is read.');
    notification.readAt = body.read ? new Date().toISOString() : null;
    await saveStore(store);
    return send(res, 200, { notification });
  }
  if (method === 'GET' && url.pathname === '/api/audit-logs') {
    const user = requireUser(req, res, ['developer', 'owner']);
    if (!user) return;
    const ownerIds = visibleOwnerIds(user);
    const requestedLimit = Number(url.searchParams.get('limit') || 100);
    const limit = Number.isInteger(requestedLimit) ? Math.min(500, Math.max(1, requestedLimit)) : 100;
    const logs = store.auditLogs
      .filter(entry => user.role === 'developer' || ownerIds.includes(entry.ownerId) || entry.actorId === user.id)
      .slice(0, limit)
      .map(entry => ({
        ...entry,
        actorName: store.users.find(candidate => candidate.id === entry.actorId)?.name || 'System'
      }));
    return send(res, 200, { auditLogs: logs });
  }
  if (method === 'GET' && url.pathname === '/api/reminder-settings') {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    return send(res, 200, { settings: rentReminderSettings(user.id) });
  }
  if (method === 'PATCH' && url.pathname === '/api/reminder-settings') {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const body = await readJson(req);
    const validDays = values => Array.isArray(values) && values.length <= 8
      && values.every(value => Number.isInteger(value) && value >= -30 && value <= 90);
    if (typeof body.enabled !== 'boolean' || !validDays(body.days) || !validDays(body.leaseDays)) {
      return error(res, 422, 'Choose whether reminders are enabled and provide valid rent and lease reminder days.');
    }
    const settings = {
      enabled: body.enabled,
      days: [...new Set(body.days)].sort((a, b) => a - b),
      leaseDays: [...new Set(body.leaseDays)].sort((a, b) => b - a)
    };
    store.reminderSettings[user.id] = settings;
    recordAudit(user, 'reminders.settings_updated', user.id, { ownerId: user.id, settings });
    await saveStore(store);
    return send(res, 200, { settings });
  }
  if (method === 'GET' && url.pathname === '/api/reminder-history') {
    const user = requireUser(req, res, ['developer', 'owner']);
    if (!user) return;
    const ownerIds = visibleOwnerIds(user);
    const history = store.reminderHistory.filter(entry => user.role === 'developer' || ownerIds.includes(entry.ownerId)).slice(0, 200);
    return send(res, 200, { history });
  }
  if (method === 'GET' && url.pathname === '/api/reports') {
    const user = requireUser(req, res, ['developer', 'owner']);
    if (!user) return;
    const type = url.searchParams.get('type') || '';
    if (!['rent', 'arrears', 'occupancy', 'maintenance', 'lease-expiry'].includes(type)) {
      return error(res, 422, 'Choose a supported report type.');
    }
    const startDate = url.searchParams.get('from') || '';
    const endDate = url.searchParams.get('to') || '';
    if ((startDate && !validDate(startDate)) || (endDate && !validDate(endDate)) || (startDate && endDate && startDate > endDate)) {
      return error(res, 422, 'Choose a valid report date range.');
    }
    const rows = managementReportRows(type, user, startDate, endDate);
    return sendCsv(res, `propertyflow-${type}-${dateInNairobi()}.csv`, csvDocument(rows));
  }
  if (method === 'POST' && url.pathname === '/api/files') {
    const user = requireUser(req, res, ['developer', 'owner', 'tenant', 'agent']);
    if (!user) return;
    const purpose = url.searchParams.get('purpose');
    let relationship;
    if (purpose === 'request-photo') {
      const request = store.requests.find(item => item.id === url.searchParams.get('requestId'));
      if (!request) return error(res, 404, 'Maintenance request not found.');
      const allowed = user.role === 'developer'
        || (user.role === 'tenant' && request.tenantId === user.id)
        || (user.role === 'owner' && visibleOwnerIds(user).includes(request.ownerId))
        || (user.role === 'agent' && request.ownerId === user.ownerId
          && store.workOrders.some(order => order.requestId === request.id && order.assignedAgentId === user.id));
      if (!allowed) return error(res, 403, 'You cannot add files to this maintenance request.');
      relationship = { requestId: request.id, ownerId: request.ownerId, propertyId: request.propertyId };
    } else if (purpose === 'lease-document') {
      if (user.role !== 'owner' && user.role !== 'developer') return error(res, 403, 'Only property owners can add lease documents.');
      const lease = store.leases.find(item => item.id === url.searchParams.get('leaseId')
        && (user.role === 'developer' || visibleOwnerIds(user).includes(item.ownerId)));
      if (!lease) return error(res, 404, 'Lease not found.');
      relationship = { leaseId: lease.id, ownerId: lease.ownerId, propertyId: lease.propertyId };
    } else {
      return error(res, 422, 'Choose a maintenance photo or lease document.');
    }
    try {
      assertStorageConfigured();
    } catch (cause) {
      return error(res, cause.status || 503, cause.message);
    }
    const buffer = await readBinary(req, 10_000_000);
    const contentType = detectContentType(buffer);
    if (!contentType) return error(res, 415, 'Upload a JPEG, PNG, WebP image, or PDF document.');
    const fileId = id('file');
    const fileName = safeFileName(url.searchParams.get('name'), contentType);
    const objectKey = newObjectKey(relationship.ownerId, fileId, contentType);
    try {
      await putPrivateObject(objectKey, buffer, contentType);
      const file = {
        id: fileId,
        ...relationship,
        purpose,
        uploadedById: user.id,
        name: fileName,
        contentType,
        size: buffer.length,
        objectKey,
        createdAt: new Date().toISOString()
      };
      store.files.unshift(file);
      recordAudit(user, 'file.uploaded', fileId, {
        ownerId: relationship.ownerId, propertyId: relationship.propertyId,
        purpose, relatedId: relationship.requestId || relationship.leaseId,
        contentType, size: buffer.length
      });
      await saveStore(store);
      return send(res, 201, { file: publicFile(file) });
    } catch (cause) {
      try { await deletePrivateObject(objectKey); } catch (cleanupError) {
        console.error(`Could not clean up failed file upload ${fileId}:`, cleanupError.message);
      }
      console.error(`Private file upload failed for ${fileId}:`, cause.message);
      return error(res, 502, 'The file could not be stored securely. Please try again.');
    }
  }
  const fileDownloadMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
  if (method === 'GET' && fileDownloadMatch) {
    const user = requireUser(req, res, ['developer', 'owner', 'tenant', 'agent']);
    if (!user) return;
    const file = store.files.find(item => item.id === fileDownloadMatch[1]);
    if (!file) return error(res, 404, 'File not found.');
    if (!userCanAccessFile(user, file)) return error(res, 403, 'You cannot access this file.');
    try {
      const downloadUrl = await createPrivateDownloadUrl(file.objectKey, file.name, file.contentType);
      return send(res, 200, { file: publicFile(file), downloadUrl, expiresIn: 60 });
    } catch (cause) {
      console.error(`Private file download link failed for ${file.id}:`, cause.message);
      return error(res, cause.status || 502, cause.status === 503 ? cause.message : 'A secure file link could not be created.');
    }
  }
  if (method === 'GET' && url.pathname === '/api/payments') {
    const user = requireUser(req, res, ['developer', 'owner', 'tenant']);
    if (!user) return;
    const ownerIds = visibleOwnerIds(user);
    const payments = store.payments.filter(payment => paymentScope(user, payment));
    return send(res, 200, { payments });
  }
  const receiptMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/receipt$/);
  if (method === 'GET' && receiptMatch) {
    const user = requireUser(req, res, ['developer', 'owner', 'tenant']);
    if (!user) return;
    const payment = store.payments.find(item => item.id === receiptMatch[1] && paymentScope(user, item));
    if (!payment) return error(res, 404, 'Payment not found.');
    if (payment.status !== 'paid' || !payment.receiptNumber) return error(res, 409, 'A receipt is available after the payment is confirmed.');
    const tenant = store.users.find(item => item.id === payment.tenantId);
    const property = propertyFor(payment.propertyId);
    return send(res, 200, {
      receipt: {
        receiptNumber: payment.receiptNumber, paymentId: payment.id, amount: payment.amount,
        currency: payment.currency || 'KES', method: payment.method, reference: payment.reference || payment.receiptNumber,
        paidAt: payment.paidAt, dueDate: payment.dueDate, tenant: tenant?.name || 'Tenant',
        tenantEmail: tenant?.email || '', property: property?.name || 'Property'
      }
    });
  }
  if (method === 'POST' && url.pathname === '/api/payments/tenant-report') {
    const user = requireUser(req, res, ['tenant']);
    if (!user) return;
    const body = await readJson(req);
    const methodName = String(body.method || '');
    const settingName = {
      mpesa_phone: 'mpesaPhone',
      mpesa_paybill: 'mpesaPaybill',
      mpesa_bank: 'mpesaBank',
      bank: 'bankTransfer',
      cash: 'cash'
    }[methodName];
    if (!settingName || ownerPaymentSettingsFor(user.ownerId)[settingName]?.enabled !== true) {
      return error(res, 422, 'Choose a payment method enabled by your property owner.');
    }
    const amount = Number(body.amount);
    const reference = String(body.reference || '').trim().slice(0, 100);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) {
      return error(res, 422, 'Enter a valid payment amount.');
    }
    if (!reference) return error(res, 422, 'Enter the transaction reference or cash receipt number.');
    const dueDate = user.nextRentDue || new Date().toISOString().slice(0, 10);
    const lease = store.leases.find(item => item.tenantId === user.id && ['pending', 'active'].includes(item.status));
    const dueAmount = lease ? rentAt(lease, dueDate) : Number(user.rentAmount) || 0;
    const alreadyAccounted = store.payments
      .filter(item => item.tenantId === user.id && item.dueDate === dueDate
        && ['paid', 'review', 'pending'].includes(item.status))
      .reduce((sum, item) => sum + item.amount, 0);
    if (amount > Math.max(0, dueAmount - alreadyAccounted)) {
      return error(res, 409, 'The reported payment exceeds the remaining rent balance.');
    }
    if (store.payments.some(item => item.ownerId === user.ownerId
      && item.reference?.toLowerCase() === reference.toLowerCase())) {
      return error(res, 409, 'That payment reference has already been recorded.');
    }
    const payment = {
      id: id('payment'),
      ownerId: user.ownerId,
      tenantId: user.id,
      propertyId: user.propertyId,
      amount,
      currency: 'KES',
      method: methodName,
      reference,
      status: 'review',
      reconciliationStatus: 'pending',
      paymentSource: 'tenant_reported',
      dueDate,
      createdAt: new Date().toISOString()
    };
    store.payments.unshift(payment);
    recordAudit(user, 'payment.reported_by_tenant', payment.id, {
      ownerId: payment.ownerId, tenantId: payment.tenantId, amount, method: methodName, reference, dueDate
    });
    await saveStore(store);
    return send(res, 201, { payment, message: 'Payment submitted for owner verification.' });
  }
  if (method === 'POST' && url.pathname === '/api/payments/manual') {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const body = await readJson(req);
    const ownerIds = visibleOwnerIds(user);
    const tenant = store.users.find(item => item.id === body.tenantId && item.role === 'tenant'
      && item.status === 'active' && ownerIds.includes(item.ownerId));
    const amount = Number(body.amount);
    const dueDate = String(body.dueDate || tenant?.nextRentDue || '');
    const methodName = String(body.method || '');
    const reference = String(body.reference || '').trim().slice(0, 100);
    if (!tenant) return error(res, 422, 'Choose an active tenant you manage.');
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) return error(res, 422, 'Enter a valid payment amount.');
    if (!['bank', 'cash'].includes(methodName)) return error(res, 422, 'Choose bank transfer or cash.');
    if (!reference) return error(res, 422, 'Enter the bank transaction or cash receipt reference.');
    if (!validDate(dueDate)) return error(res, 422, 'Enter a valid rent due date.');
    if (store.payments.some(item => item.ownerId === tenant.ownerId && item.reference?.toLowerCase() === reference.toLowerCase())) {
      return error(res, 409, 'That payment reference has already been recorded.');
    }
    const payment = {
      id: id('payment'), ownerId: tenant.ownerId, tenantId: tenant.id, propertyId: tenant.propertyId,
      amount, currency: 'KES', method: methodName, reference, status: 'review',
      reconciliationStatus: 'pending', dueDate, createdAt: new Date().toISOString()
    };
    store.payments.unshift(payment);
    recordAudit(user, 'payment.recorded', payment.id, {
      ownerId: payment.ownerId, tenantId: payment.tenantId, amount, method: methodName, reference, dueDate
    });
    await saveStore(store);
    return send(res, 201, { payment });
  }
  const reconcilePaymentMatch = url.pathname.match(/^\/api\/payments\/([^/]+)\/reconcile$/);
  if (method === 'PATCH' && reconcilePaymentMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const payment = store.payments.find(item => item.id === reconcilePaymentMatch[1]
      && visibleOwnerIds(user).includes(item.ownerId));
    if (!payment) return error(res, 404, 'Payment not found.');
    if (payment.status !== 'review') return error(res, 409, 'Only payments awaiting review can be reconciled.');
    const body = await readJson(req);
    if (!['confirm', 'reject'].includes(body.action)) return error(res, 422, 'Choose confirm or reject.');
    const tenant = store.users.find(item => item.id === payment.tenantId);
    if (body.action === 'confirm') {
      payment.status = 'paid';
      payment.reconciliationStatus = 'confirmed';
      payment.reviewedBy = user.id;
      payment.paidAt = new Date().toISOString();
      payment.receiptNumber ||= `PF-${dateInNairobi().replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const property = propertyFor(payment.propertyId);
      if (property) property.collectedThisMonth += payment.amount;
      if (tenant) advanceRentDueIfCovered(tenant, payment.dueDate);
    } else {
      payment.status = 'failed';
      payment.reconciliationStatus = 'rejected';
      payment.failureReason = String(body.reason || 'Payment reference could not be confirmed.').trim().slice(0, 300);
      payment.reviewedBy = user.id;
    }
    payment.reviewedAt = new Date().toISOString();
    recordAudit(user, `payment.${payment.reconciliationStatus}`, payment.id, {
      ownerId: payment.ownerId, tenantId: payment.tenantId, amount: payment.amount,
      reference: payment.reference, receiptNumber: payment.receiptNumber || null
    });
    await saveStore(store);
    if (tenant && payment.status === 'paid') {
      await notifyUsers([tenant, ...ownerManagementRecipients(payment.ownerId)], 'Rent payment confirmed',
        `Your KES ${payment.amount} payment was confirmed. Receipt: ${payment.receiptNumber}.`,
        payment.id, { type: 'payment', actionUrl: '/?section=payments' });
    } else if (tenant) {
      await notifyUser(tenant, 'Payment needs follow-up', payment.failureReason, payment.id, { type: 'payment' });
    }
    return send(res, 200, { payment });
  }
  if (method === 'POST' && url.pathname === '/api/payments/mpesa/stk-push') {
    const user = requireUser(req, res, ['tenant']);
    if (!user) return;
    if (!process.env.DARAJA_CONSUMER_KEY || !process.env.DARAJA_CALLBACK_TOKEN) {
      return error(res, 503, 'M-Pesa payments are not configured yet.');
    }
    const mpesaDestination = ownerPaymentSettingsFor(user.ownerId).mpesaPaybill;
    if (!process.env.DARAJA_OWNER_ID || process.env.DARAJA_OWNER_ID !== user.ownerId
      || !mpesaDestination.enabled || mpesaDestination.number !== process.env.DARAJA_SHORTCODE) {
      return error(res, 503, 'STK checkout is not enabled for this owner’s configured Paybill/Till. Use the owner’s payment instructions instead.');
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
      recordAudit(user, 'payment.initiated', payment.id, {
        ownerId: payment.ownerId, tenantId: payment.tenantId, amount: payment.amount, dueDate
      });
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
    const previousStatus = payment.status;
    const alreadyPaid = previousStatus === 'paid';
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
        payment.receiptNumber = String(metadata.MpesaReceiptNumber
          || `PF-${dateInNairobi().replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`);
        payment.paidAt = new Date().toISOString();
        const property = propertyFor(payment.propertyId);
        if (property) property.collectedThisMonth += payment.amount;
        const tenant = store.users.find(item => item.id === payment.tenantId);
        if (tenant) advanceRentDueIfCovered(tenant, payment.dueDate);
      }
    } else if (payment.status === 'pending') {
      payment.status = 'failed';
      payment.failureReason = String(callback.ResultDesc || 'M-Pesa payment was not completed.').slice(0, 300);
    }
    payment.updatedAt = new Date().toISOString();
    if (previousStatus !== payment.status) {
      recordAudit(null, `payment.${payment.status}`, payment.id, {
        ownerId: payment.ownerId, tenantId: payment.tenantId, amount: payment.amount,
        receiptNumber: payment.receiptNumber || null, failureReason: payment.failureReason || null
      });
    }
    await saveStore(store);
    const tenant = store.users.find(item => item.id === payment.tenantId);
    if (previousStatus === 'pending' && payment.status === 'paid' && tenant) {
      await notifyUsers([tenant, ...ownerManagementRecipients(payment.ownerId)], 'Rent payment received',
        `${tenant.name} paid KES ${payment.amount}. Receipt: ${payment.receiptNumber || 'pending'}.`,
        payment.id, { type: 'payment', actionUrl: '/?section=payments' });
    } else if (previousStatus === 'pending' && payment.status === 'failed' && tenant) {
      await notifyUser(tenant, 'Rent payment was not completed',
        `Your KES ${payment.amount} rent payment was not completed. You can try again or contact your property owner.`,
        payment.id, { type: 'payment', actionUrl: '/?section=payments' });
    } else if (previousStatus === 'pending' && payment.status === 'review') {
      const developers = store.users.filter(item => item.role === 'developer' && item.status === 'active');
      await notifyUsers([...ownerManagementRecipients(payment.ownerId), ...developers],
        'Rent payment needs review', `A payment for KES ${payment.amount} needs reconciliation.`, payment.id,
        { type: 'payment', actionUrl: '/?section=payments' });
    }
    return send(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' });
  }
  if (method === 'POST' && url.pathname === '/api/owners') {
    const user = requireUser(req, res, ['developer']);
    if (!user) return;
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = body.phone ? normalizeKenyanPhone(body.phone) : null;
    const tenantSeatAllocation = Number(body.tenantSeatAllocation);
    const agentSeatAllocation = body.agentSeatAllocation === undefined ? 2 : Number(body.agentSeatAllocation);
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return error(res, 422, 'Enter an owner name and valid work email.');
    if (body.phone && !phone) return error(res, 422, 'Enter a valid Kenyan mobile number.');
    if (store.users.some(item => item.email === email)) return error(res, 409, 'An account already uses that email.');
    if (!Number.isInteger(tenantSeatAllocation) || tenantSeatAllocation < 50) return error(res, 422, 'Each property owner must receive at least 50 tenant seats.');
    if (!Number.isInteger(agentSeatAllocation) || agentSeatAllocation < 0 || agentSeatAllocation > 2) return error(res, 422, 'Agent allocation must be between 0 and 2.');
    const invite = invitation();
    const owner = { id: id('owner'), name, email, phone, role: 'owner', passwordHash: '', status: 'invited', tenantSeatAllocation, tenantSeatsUsed: 0, agentSeatAllocation, ownerIds: [], invitedById: user.id, invitationTokenHash: invite.invitationTokenHash, invitationExpiresAt: invite.invitationExpiresAt };
    store.users.push(owner);
    await saveStore(store);
    const delivery = await deliverAccountInvite(owner, invite.token);
    return send(res, 201, { owner: publicUser(owner), ...delivery, message: 'Owner created. Account activation instructions were sent where delivery is configured.' });
  }
  if (method === 'POST' && url.pathname === '/api/agents') {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = body.phone ? normalizeKenyanPhone(body.phone) : null;
    const ownerIds = visibleOwnerIds(user);
    const owner = store.users.find(item => item.id === (body.ownerId || user.id) && item.role === 'owner' && ownerIds.includes(item.id));
    const agentType = String(body.agentType || '');
    const existingAgentCount = store.users.filter(item => item.role === 'agent' && ownerIds.includes(item.ownerId)).length;
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return error(res, 422, 'Enter an agent name and valid email.');
    if (body.phone && !phone) return error(res, 422, 'Enter a valid Kenyan mobile number.');
    if (!owner) return error(res, 422, 'Choose an owner in your property portfolio.');
    if (!['primary', 'backup'].includes(agentType)) return error(res, 422, 'Choose a primary or backup agent role.');
    if (store.users.some(item => item.email === email)) return error(res, 409, 'An account already uses that email.');
    if (existingAgentCount >= user.agentSeatAllocation) return error(res, 422, 'No agent seats are available in your allocation.');
    if (store.users.some(item => item.role === 'agent' && item.ownerId === owner.id && item.agentType === agentType)) return error(res, 409, `This owner already has a ${agentType} agent.`);
    const invite = invitation();
    const agent = { id: id('agent'), name, email, phone, role: 'agent', passwordHash: '', status: 'invited', ownerId: owner.id, agentType, invitedById: user.id, invitationTokenHash: invite.invitationTokenHash, invitationExpiresAt: invite.invitationExpiresAt };
    store.users.push(agent);
    await saveStore(store);
    const delivery = await deliverAccountInvite(agent, invite.token);
    return send(res, 201, { agent: publicUser(agent), ...delivery });
  }
  const propertyUnitsMatch = url.pathname.match(/^\/api\/properties\/([^/]+)\/units$/);
  if (method === 'POST' && propertyUnitsMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const property = store.properties.find(item => item.id === propertyUnitsMatch[1] && visibleOwnerIds(user).includes(item.ownerId));
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
    recordAudit(user, 'unit.created', unit.id, { ownerId: property.ownerId, propertyId: property.id, unitNumber });
    await saveStore(store);
    return send(res, 201, { unit: publicUnit(unit) });
  }
  const unitQrMatch = url.pathname.match(/^\/api\/units\/([^/]+)\/qr$/);
  if (method === 'POST' && unitQrMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const unit = store.units.find(item => item.id === unitQrMatch[1] && visibleOwnerIds(user).includes(item.ownerId));
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
    recordAudit(user, 'unit.qr_rotated', unit.id, { ownerId: unit.ownerId, propertyId: unit.propertyId });
    await saveStore(store);
    return send(res, 200, { unit: publicUnit(unit), qrUrl, qrCode });
  }
  const unitResolveMatch = url.pathname.match(/^\/api\/units\/resolve\/([^/]+)$/);
  if (method === 'GET' && unitResolveMatch) {
    const user = requireUser(req, res, ['developer', 'owner', 'tenant', 'agent']);
    if (!user) return;
    const qrTokenHash = crypto.createHash('sha256').update(unitResolveMatch[1]).digest('hex');
    const unit = store.units.find(item => item.qrTokenHash === qrTokenHash);
    if (!unit) return error(res, 404, 'This unit QR code is invalid or has been replaced.');
    const hasAccess = user.role === 'developer'
      || (user.role === 'owner' && visibleOwnerIds(user).includes(unit.ownerId))
      || (user.role === 'tenant' && user.unitId === unit.id)
      || (user.role === 'agent' && user.ownerId === unit.ownerId && store.workOrders.some(order => {
        if (order.assignedAgentId !== user.id || order.propertyId !== unit.propertyId) return false;
        const request = store.requests.find(item => item.id === order.requestId);
        const tenant = request && store.users.find(item => item.id === request.tenantId);
        return order.unit === unit.unitNumber || tenant?.unitId === unit.id;
      }));
    if (!hasAccess) return error(res, 403, 'This QR code is not assigned to your account.');
    const property = propertyFor(unit.propertyId);
    recordAudit(user, 'unit.qr_scanned', unit.id, { ownerId: unit.ownerId, propertyId: unit.propertyId });
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
    const ownerIds = visibleOwnerIds(user);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const phone = body.phone ? normalizeKenyanPhone(body.phone) : null;
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) return error(res, 422, 'Enter the tenant’s name and email.');
    if (body.phone && !phone) return error(res, 422, 'Enter a valid Kenyan mobile number.');
    if (store.users.some(item => item.email === email)) return error(res, 409, 'An account already uses that email.');
    let unit = body.unitId && store.units.find(item => item.id === body.unitId && ownerIds.includes(item.ownerId));
    let unitCreated = false;
    const property = unit
      ? store.properties.find(item => item.id === unit.propertyId && ownerIds.includes(item.ownerId))
      : store.properties.find(item => item.id === body.propertyId && ownerIds.includes(item.ownerId));
    if (!property) return error(res, 422, 'Choose one of your properties.');
    const quotaAccounts = ownerQuotaAccounts(property.ownerId);
    if (!quotaAccounts.length || quotaAccounts.some(account => account.tenantSeatsUsed >= account.tenantSeatAllocation)) {
      return error(res, 422, 'No tenant seats are available in this property owner’s allocation.');
    }
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
    const tenant = { id: id('tenant'), name, email, phone, role: 'tenant', passwordHash: '', status: 'invited', ownerId: property.ownerId, propertyId: property.id, unit: unit.unitNumber, unitId: unit.id, leaseStarts, leaseEnds, nextRentDue, rentAmount, invitedById: user.id, invitationTokenHash: invite.invitationTokenHash, invitationExpiresAt: invite.invitationExpiresAt };
    const leaseId = id('lease');
    const lease = {
      id: leaseId,
      tenantId: tenant.id,
      ownerId: property.ownerId,
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
    for (const account of quotaAccounts) account.tenantSeatsUsed += 1;
    property.occupiedUnits += 1;
    property.monthlyRentExpected += rentAmount;
    recordAudit(user, 'lease.created', lease.id, {
      ownerId: lease.ownerId, propertyId: lease.propertyId, tenantId: tenant.id,
      unitId: unit.id, rentAmount, leaseStarts, leaseEnds
    });
    recordAudit(user, 'tenant.assigned', tenant.id, {
      ownerId: tenant.ownerId, propertyId: tenant.propertyId, unitId: tenant.unitId, leaseId: lease.id
    });
    await saveStore(store);
    const delivery = await deliverAccountInvite(tenant, invite.token);
    return send(res, 201, { tenant: publicUser(tenant), ...delivery });
  }
  const leaseRentMatch = url.pathname.match(/^\/api\/leases\/([^/]+)\/rent$/);
  if (method === 'PATCH' && leaseRentMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const lease = store.leases.find(item => item.id === leaseRentMatch[1] && visibleOwnerIds(user).includes(item.ownerId) && ['pending', 'active'].includes(item.status));
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
    recordAudit(user, 'lease.rent_changed', lease.id, {
      ownerId: lease.ownerId, propertyId: lease.propertyId, tenantId: lease.tenantId,
      effectiveDate, previousAmount: previousCurrentRent, newAmount: amount
    });
    await saveStore(store);
    if (tenant) await notifyUser(tenant, 'Rent amount updated', `Your monthly rent will be KES ${amount} from ${effectiveDate}.`, lease.id, { type: 'lease' });
    return send(res, 200, { lease: { ...lease, currentRent } });
  }
  if (method === 'POST' && url.pathname === '/api/move-outs') {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const body = await readJson(req);
    const ownerIds = visibleOwnerIds(user);
    const tenant = store.users.find(item => item.id === body.tenantId && item.role === 'tenant' && ownerIds.includes(item.ownerId) && item.status === 'active');
    const date = String(body.date || '');
    const status = ['notice', 'confirmed', 'lease_renewal'].includes(body.status) ? body.status : 'notice';
    if (!tenant) return error(res, 422, 'Choose an active tenant account you manage.');
    if (!validDate(date)) return error(res, 422, 'Enter a valid expected move-out date.');
    if (store.moveOuts.some(item => item.tenantId === tenant.id && !['completed', 'cancelled'].includes(item.status))) {
      return error(res, 409, 'This tenant already has an open move-out record.');
    }
    const property = propertyFor(tenant.propertyId);
    const moveOut = { id: id('move'), ownerId: tenant.ownerId, tenantId: tenant.id, tenant: tenant.name, unit: tenant.unit, property: property?.name || 'Property', date, status, createdAt: new Date().toISOString() };
    store.moveOuts.unshift(moveOut);
    recordAudit(user, 'move_out.recorded', moveOut.id, {
      ownerId: tenant.ownerId, tenantId: tenant.id, propertyId: tenant.propertyId, date, status
    });
    await saveStore(store);
    await notifyUser(tenant, 'Move-out notice recorded', `Your planned move-out for ${date} has been recorded as ${status.replaceAll('_', ' ')}.`, moveOut.id, { type: 'lease' });
    return send(res, 201, { moveOut });
  }
  const moveOutMatch = url.pathname.match(/^\/api\/move-outs\/([^/]+)\/status$/);
  if (method === 'PATCH' && moveOutMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const ownerIds = visibleOwnerIds(user);
    const moveOut = store.moveOuts.find(item => item.id === moveOutMatch[1] && ownerIds.includes(item.ownerId));
    if (!moveOut) return error(res, 404, 'Move-out record not found.');
    const body = await readJson(req);
    if (!['completed', 'cancelled'].includes(body.status)) return error(res, 422, 'Choose completed or cancelled.');
    if (['completed', 'cancelled'].includes(moveOut.status)) return error(res, 409, 'This move-out record is already closed.');
    if (body.status === 'completed') {
      const tenant = store.users.find(item => item.id === moveOut.tenantId && ownerIds.includes(item.ownerId) && item.role === 'tenant' && item.status === 'active');
      if (!tenant) return error(res, 409, 'The tenant account is not active.');
      tenant.status = 'inactive';
      for (const [hash, session] of Object.entries(store.sessions)) {
        if (session.userId === tenant.id) delete store.sessions[hash];
      }
      for (const account of ownerQuotaAccounts(tenant.ownerId)) {
        account.tenantSeatsUsed = Math.max(0, account.tenantSeatsUsed - 1);
      }
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
      recordAudit(user, 'lease.ended', lease?.id || tenant.id, {
        ownerId: tenant.ownerId, tenantId: tenant.id, propertyId: tenant.propertyId
      });
    }
    moveOut.status = body.status;
    moveOut.closedAt = new Date().toISOString();
    recordAudit(user, `move_out.${body.status}`, moveOut.id, {
      ownerId: moveOut.ownerId, tenantId: moveOut.tenantId, status: body.status
    });
    await saveStore(store);
    const tenant = store.users.find(item => item.id === moveOut.tenantId);
    if (tenant) await notifyUser(tenant, body.status === 'completed' ? 'Move-out completed' : 'Move-out cancelled',
      body.status === 'completed' ? 'Your move-out has been completed and the unit is now marked vacant.' : 'Your move-out notice was cancelled.',
      moveOut.id, { type: 'lease' });
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
    recordAudit(user, 'maintenance.requested', request.id, {
      ownerId: request.ownerId, tenantId: user.id, propertyId: request.propertyId,
      priority: request.priority, type: request.type
    });
    await saveStore(store);
    const agents = store.users.filter(item => item.role === 'agent' && item.ownerId === user.ownerId && item.status === 'active');
    const developers = request.priority === 'high' ? store.users.filter(item => item.role === 'developer' && item.status === 'active') : [];
    const notifications = await notifyUsers([...ownerManagementRecipients(user.ownerId), ...agents, ...developers],
      `New tenant request: ${title}`, `${user.name} reported ${title} at ${propertyFor(user.propertyId)?.name || 'their property'} · ${user.unit}. Priority: ${request.priority}.`,
      request.id, { type: request.priority === 'high' ? 'urgent' : 'maintenance', actionUrl: '/?section=maintenance' });
    return send(res, 201, { request: requestView(request), notifications });
  }
  const assignRequestMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/assign$/);
  if (method === 'POST' && assignRequestMatch) {
    const user = requireUser(req, res, ['owner']);
    if (!user) return;
    const ownerIds = visibleOwnerIds(user);
    const request = store.requests.find(item => item.id === assignRequestMatch[1] && ownerIds.includes(item.ownerId));
    if (!request) return error(res, 404, 'Request not found.');
    if (request.status === 'resolved') return error(res, 409, 'Resolved requests cannot be assigned.');
    const existingOrder = store.workOrders.find(item => item.requestId === request.id);
    if (request.status === 'in_progress'
      || (existingOrder && !['open', 'scheduled'].includes(existingOrder.status))) {
      return error(res, 409, 'Work has already started or finished. Reassignment is not allowed at this workflow step.');
    }
    const body = await readJson(req);
    const agent = store.users.find(item => item.id === body.agentId && item.role === 'agent' && ownerIds.includes(item.ownerId) && item.status === 'active');
    if (!agent) return error(res, 422, 'Choose an active agent assigned to your properties.');
    const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : new Date();
    if (Number.isNaN(scheduledFor.getTime())) return error(res, 422, 'Enter a valid scheduled date and time.');
    let order = existingOrder;
    const previousAgentId = order?.assignedAgentId || null;
    if (order) {
      order.assignedAgentId = agent.id;
      order.scheduledFor = scheduledFor.toISOString();
      order.status = 'open';
      delete order.completedAt;
    } else {
      order = { id: id('work'), requestId: request.id, ownerId: request.ownerId, propertyId: request.propertyId, unit: requestView(request).unit, title: request.title, priority: request.priority, assignedAgentId: agent.id, status: 'open', scheduledFor: scheduledFor.toISOString() };
      store.workOrders.push(order);
    }
    request.status = 'assigned';
    recordAudit(user, 'work_order.assigned', order.id, {
      ownerId: order.ownerId, requestId: request.id, previousAgentId,
      agentId: agent.id, scheduledFor: order.scheduledFor
    });
    await saveStore(store);
    const tenant = store.users.find(item => item.id === request.tenantId);
    const notifications = await notifyUsers([agent, tenant], `Work assigned: ${request.title}`, `${request.title} has been assigned to ${agent.name}. Scheduled for ${scheduledFor.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}.`, request.id, { type: 'work_order', actionUrl: '/?section=work-orders' });
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
    const previousStatus = order.status;
    const allowedNextStatuses = {
      open: ['in_progress'],
      scheduled: ['in_progress'],
      in_progress: ['completed']
    };
    if (!allowedNextStatuses[previousStatus]?.includes(body.status)) {
      return error(res, 409, 'Work orders must be started before completion, and completed work cannot be reopened.');
    }
    order.status = body.status;
    const request = store.requests.find(item => item.id === order.requestId);
    if (request) request.status = body.status === 'completed' ? 'resolved' : 'in_progress';
    if (body.status === 'completed') {
      order.completedAt = new Date().toISOString();
    }
    recordAudit(user, `work_order.${body.status}`, order.id, {
      ownerId: order.ownerId, requestId: request?.id || null, previousStatus, status: order.status
    });
    await saveStore(store);
    const tenant = request && store.users.find(item => item.id === request.tenantId);
    const label = body.status === 'completed' ? 'resolved' : 'in progress';
    const developers = order.priority === 'high' ? store.users.filter(item => item.role === 'developer' && item.status === 'active') : [];
    const notifications = await notifyUsers([tenant, ...ownerManagementRecipients(order.ownerId), ...developers],
      `Request ${label}: ${order.title}`, `${order.title} is now ${label}.`, request?.id || order.id,
      { type: body.status === 'completed' ? 'resolved' : 'work_order', actionUrl: '/?section=maintenance' });
    return send(res, 200, { workOrder: workOrderView(order), notifications });
  }
  return error(res, 404, 'Endpoint not found.');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};
function publicDocumentHeaders(filePath) {
  return {
    'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...(process.env.NODE_ENV === 'production' ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
  };
}
async function servePublicDocuments(res, pathname) {
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); } catch { return error(res, 400, 'Invalid document path.'); }
  const documentPath = decodedPath === '/documents' || decodedPath === '/documents/'
    ? '/index.html'
    : decodedPath.slice('/documents/'.length);
  const filePath = path.resolve(PUBLIC_LEGAL_DIR, `.${documentPath.startsWith('/') ? documentPath : `/${documentPath}`}`);
  const relativePath = path.relative(PUBLIC_LEGAL_DIR, filePath);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return error(res, 403, 'Forbidden');
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, publicDocumentHeaders(filePath));
    res.end(content);
  } catch (cause) {
    if (cause.code === 'ENOENT') return error(res, 404, 'Document not found.');
    return error(res, 500, 'Unable to read the requested document.');
  }
}
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
      ...publicDocumentHeaders(filePath),
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    res.end(content);
  } catch (cause) {
    if (cause.code === 'ENOENT') return error(res, 404, 'Page not found.');
    return error(res, 500, 'Unable to read the requested file.');
  }
}

let reminderSweepRunning = false;

async function executeRentReminderSweep() {
  if (reminderSweepRunning) return;
  reminderSweepRunning = true;
  try {
    if (!database) {
      const task = apiQueue.then(() => runRentReminderSweep());
      apiQueue = task.then(() => undefined, () => undefined);
      await task;
      return;
    }
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT state FROM propertyflow_state WHERE id = 1 FOR UPDATE');
      if (!result.rows.length) throw new Error('Persistent application state has not been initialized.');
      store = normalizeStore(result.rows[0].state);
      await databaseTransactions.run(client, runRentReminderSweep);
      await client.query('COMMIT');
    } catch (cause) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) { console.error('Reminder scheduler rollback failed:', rollbackError); }
      throw cause;
    } finally {
      client.release();
    }
  } finally {
    reminderSweepRunning = false;
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
    if (url.pathname === '/documents' || url.pathname.startsWith('/documents/')) return await servePublicDocuments(res, url.pathname);
    return await serveStatic(res, url.pathname);
  } catch (cause) {
    console.error(cause);
    return error(res, cause.status || 500, cause.status ? cause.message : 'Unexpected server error.');
  }
});

assertProductionConfig();
loadStore().then(loaded => {
  store = loaded;
  server.listen(PORT, HOST, () => {
    console.log(`PropertyFlow is running on port ${PORT}`);
    const schedulerEnabled = process.env.NODE_ENV === 'production'
      ? process.env.REMINDER_SCHEDULER_ENABLED !== 'false'
      : process.env.REMINDER_SCHEDULER_ENABLED === 'true';
    if (schedulerEnabled) {
      const run = () => executeRentReminderSweep().catch(cause => console.error('Rent and lease reminder sweep failed:', cause.message));
      const timer = setInterval(run, 15 * 60 * 1000);
      timer.unref();
      setTimeout(run, 15_000).unref();
    }
  });
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
