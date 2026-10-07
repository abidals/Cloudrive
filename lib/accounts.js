'use strict';
const fsp = require('fs-promise');
const path = require('path');
const crypto = require('node:crypto');
const debug = require('debug')('cloudrive:accounts');
const config = require('../config');
const { hashPassword, verifyPassword } = require('./passwordHash');

const COOKIE_NAME = 'cloudrive_session';
const USERS_FILE = () => path.join(config.uploadDir, 'users.json');
const SECRET_FILE = () => path.join(config.uploadDir, '.session-secret');

const stored = {
  users: {},
  secret: null,
  initialized: false,
  enabled: false,
};

// config values passed via env vars arrive as strings,
// so accept "true"/"false"/"0" as well as raw booleans.
function truthy(v) {
  if (v === true) return true;
  if (typeof v === 'string') return !['', 'false', '0', 'no'].includes(v.toLowerCase());
  return false;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmacSign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(`v1:${payloadB64}`).digest('base64url');
}

function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a), 'utf8');
  const bBuf = Buffer.from(String(b), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readSecret() {
  if (stored.secret) return stored.secret;
  if (truthy(config.sessionSecret)) {
    stored.secret = String(config.sessionSecret);
  } else {
    try {
      fsp.ensureDirSync(config.uploadDir);
      const p = SECRET_FILE();
      if (fsp.existsSync(p)) {
        stored.secret = fsp.readFileSync(p, 'utf8').trim() || null;
      }
      if (!stored.secret) {
        stored.secret = crypto.randomBytes(48).toString('hex');
        fsp.writeFileSync(p, stored.secret, { mode: 0o600 });
      }
    } catch (e) {
      console.error('Cloudrive: cannot persist session secret, generate one per boot:', e.message);
      stored.secret = crypto.randomBytes(48).toString('hex');
    }
  }
  return stored.secret;
}

async function persistUsers() {
  fsp.ensureDirSync(config.uploadDir);
  await fsp.writeFile(USERS_FILE(), JSON.stringify({ users: Object.values(stored.users) }, null, 2), { mode: 0o600 });
}

async function loadUsers() {
  const p = USERS_FILE();
  if (fsp.existsSync(p)) {
    try {
      const data = JSON.parse(fsp.readFileSync(p, 'utf8'));
      stored.users = {};
      for (const u of Array.isArray(data.users) ? data.users : []) {
        if (u && u.name && u.hash) stored.users[u.name.toLowerCase()] = u;
      }
    } catch (e) {
      console.error(`Cloudrive: cannot parse ${p}: ${e.message} - starting with empty user list`);
      stored.users = {};
    }
  } else {
    stored.users = {};
  }
}

async function seedAdmin() {
  if (!stored.users || Object.keys(stored.users).length > 0) return;
  if (!truthy(config.adminUser) || !truthy(config.adminPassword)) {
    console.error('Cloudrive: accounts enabled but no users and no CLOUDRIVE_ADMIN_USER / CLOUDRIVE_ADMIN_PASSWORD bootstrap set. Nobody would be able to log in!');
    return;
  }
  const name = String(config.adminUser).trim();
  await addUser(name, String(config.adminPassword), 'admin');
  debug(`Bootstrap admin "${name}" created`);
}

async function init() {
  stored.enabled = truthy(config.accounts);
  if (!stored.enabled) return;
  await loadUsers();
  readSecret();
  await seedAdmin();
  stored.initialized = true;
}

// init runs eagerly at require-time; request handlers await `ready()` so they
// never race the (async) users.json load under a cold start.
const ready = () => init();

//------------- user management -------------

async function addUser(name, password, role = 'uploader') {
  name = String(name || '').trim();
  if (!name) throw new Error('user name required');
  if (!['admin', 'uploader'].includes(role)) throw new Error('role must be admin or uploader');
  const key = name.toLowerCase();
  if (stored.users[key]) throw new Error('user already exists');
  const hash = typeof password === 'string' && password.startsWith('$argon2') ? password : await hashPassword(String(password));
  const user = { name, role, hash, createdAt: Date.now(), disabled: false };
  stored.users[key] = user.hashed = { ...user, hash };
  await persistUsers();
  return { name, role };
}

async function removeUser(name) {
  const key = String(name || '').toLowerCase();
  if (!stored.users[key]) throw new Error('no such user');
  delete stored.users[key];
  await persistUsers();
}

async function setPassword(name, password, role) {
  const key = String(name || '').toLowerCase();
  const user = stored.users[key];
  if (!user) throw new Error('no such user');
  user.hash = typeof password === 'string' && password.startsWith('$argon2') ? password : await hashPassword(String(password));
  if (role && !['admin', 'uploader'].includes(role)) throw new Error('role must be admin or uploader');
  if (role) user.role = role;
  await persistUsers();
}

async function verifyUser(name, password) {
  const user = stored.users[String(name || '').toLowerCase()];
  if (user && !user.disabled && await verifyPassword(user.hash, String(password ?? ''))) {
    return { name: user.name, role: user.role };
  }
  return null;
}

function listUsers() {
  return Object.values(stored.users).map(({ name, role, createdAt, disabled }) => ({ name, role, createdAt, disabled }));
}

//------------- sessions -------------

function setSessionCookie(res, user) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (+config.sessionTtl || 3600 * 24);
  const payloadB64 = b64url(JSON.stringify({ u: user.name, r: user.role, iat: now, e: exp }));
  const cookie = `${COOKIE_NAME}=${payloadB64}.${hmacSign(payloadB64, readSecret())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${exp - now}`;
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readSession(req) {
  if (!stored.enabled) return null;
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw || typeof raw !== 'string') return null;
  const dot = raw.indexOf('.');
  if (dot === -1) return null;
  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = hmacSign(payloadB64, readSecret());
  if (!safeEqual(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !payload.u || !payload.r || +payload.e < Math.floor(Date.now() / 1000)) return null;
  const user = stored.users[String(payload.u).toLowerCase()];
  if (!user || user.disabled || user.role !== payload.r) return null;
  return { name: payload.u, role: payload.r };
}

//------------- middlewares -------------

// Admin always passes. Token '*' means "any authenticated user".
function requireRole(...roles) {
  return function(req, res, next) {
    if (!stored.enabled) return next();
    req.user = readSession(req);
    if (!req.user) {
      res.setHeader('Location', `${config.baseUrl}login?next=${encodeURIComponent(req.originalUrl || req.url)}`);
      return res.status(302).end();
    }
    if (req.user.role === 'admin' || roles.includes('*') || roles.includes(req.user.role)) return next();
    setTimeout(() => res.status(403).send('Forbidden'), 200);
  };
}

module.exports = {
  COOKIE_NAME,
  isEnabled: () => stored.enabled,
  init,
  ready: () => init(),
  addUser,
  removeUser,
  setPassword,
  verifyUser,
  listUsers,
  setSessionCookie,
  clearSessionCookie,
  readSession,
  requireRole,
};