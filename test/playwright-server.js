const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');
const storeFile = path.join(root, 'test-results', 'playwright-store.json');

async function start() {
  await fs.mkdir(path.dirname(storeFile), { recursive: true });
  await fs.rm(storeFile, { force: true });

  process.env.NODE_ENV = 'development';
  process.env.PORT = '3100';
  process.env.APP_BASE_URL = 'http://127.0.0.1:3100';
  process.env.PROPERTYFLOW_STORE_FILE = storeFile;
  process.env.DATABASE_URL = '';
  process.env.DARAJA_CONSUMER_KEY = '';
  process.env.DARAJA_CALLBACK_TOKEN = '';
  process.env.DARAJA_OWNER_ID = '';
  process.env.DARAJA_SHORTCODE = '';
  process.env.DARAJA_RECIPIENT_NAME = '';
  process.env.STORAGE_BUCKET = '';
  process.env.REMINDER_SCHEDULER_ENABLED = 'false';

  require('../server.js');
}

start().catch(error => {
  console.error('Unable to start the isolated Playwright server.', error);
  process.exitCode = 1;
});
