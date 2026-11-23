const crypto = require('node:crypto');
const path = require('node:path');
const { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const bucket = process.env.STORAGE_BUCKET;
const endpoint = process.env.STORAGE_ENDPOINT || undefined;
const region = process.env.STORAGE_REGION || 'us-east-1';
const configured = Boolean(bucket && process.env.STORAGE_ACCESS_KEY_ID && process.env.STORAGE_SECRET_ACCESS_KEY);
const client = configured ? new S3Client({
  region,
  endpoint,
  forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY
  }
}) : null;

const allowedTypes = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf']
]);

function detectContentType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

function safeFileName(value, contentType) {
  const name = path.basename(String(value || 'document')).replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 120);
  const extension = allowedTypes.get(contentType);
  const stem = path.basename(name, path.extname(name)).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 100) || 'document';
  return `${stem}${extension}`;
}

function newObjectKey(ownerId, fileId, contentType) {
  const extension = allowedTypes.get(contentType);
  if (!extension) throw new Error('Unsupported file type.');
  return `private/${crypto.randomUUID()}/${crypto.randomBytes(16).toString('hex')}${extension}`;
}

function assertStorageConfigured() {
  if (!configured) {
    const error = new Error('Private file storage is not configured. Set the S3-compatible storage environment variables.');
    error.status = 503;
    throw error;
  }
}

async function putPrivateObject(key, body, contentType) {
  assertStorageConfigured();
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentLength: body.length,
    ContentType: contentType,
    ContentDisposition: 'attachment',
    CacheControl: 'private, no-store'
  }));
}

async function createPrivateDownloadUrl(key, fileName, contentType) {
  assertStorageConfigured();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentType: contentType,
    ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\\\r\n]/g, '_')}"`
  });
  return getSignedUrl(client, command, { expiresIn: 60 });
}

async function deletePrivateObject(key) {
  assertStorageConfigured();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

module.exports = {
  assertStorageConfigured,
  createPrivateDownloadUrl,
  deletePrivateObject,
  detectContentType,
  isStorageConfigured: () => configured,
  newObjectKey,
  putPrivateObject,
  safeFileName
};
