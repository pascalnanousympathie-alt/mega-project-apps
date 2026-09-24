'use strict';
const crypto = require('node:crypto');

function hmacSha256Hex(secret, payload) {
  return crypto.createHmac('sha256', String(secret)).update(String(payload)).digest('hex');
}

function hmacSha512Hex(secret, payload) {
  return crypto.createHmac('sha512', String(secret)).update(String(payload)).digest('hex');
}

function basicAuthHeader(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(String(clientId) + ':' + String(clientSecret)).toString('base64');
}

function maskSecret(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text.length <= 4) return '****';
  return '****' + text.slice(-4);
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a === undefined || a === null ? '' : a));
  const right = Buffer.from(String(b === undefined || b === null ? '' : b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { hmacSha256Hex, hmacSha512Hex, basicAuthHeader, maskSecret, constantTimeEqual };
