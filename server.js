require('dotenv').config();
const express        = require('express');
const session        = require('express-session');
const cors           = require('cors');
const path           = require('path');
const fs             = require('fs');
const axios          = require('axios');
const nodemailer     = require('nodemailer');
const Imap           = require('node-imap');
const { simpleParser } = require('mailparser');
const { google }     = require('googleapis');
const bcrypt         = require('bcrypt');
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');

// ── CONFIG ──
const config = {
  GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID     || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  GOOGLE_REDIRECT_URI:  process.env.GOOGLE_REDIRECT_URI  || 'http://localhost:3000/auth/google/callback',
  GOOGLE_SCOPES: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ],
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   || '',
  TELEGRAM_API_ID:    parseInt(process.env.TELEGRAM_API_ID)  || 0,
  TELEGRAM_API_HASH:  process.env.TELEGRAM_API_HASH          || '',
  ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY          || '',
  SESSION_SECRET:     process.env.SESSION_SECRET             || 'vma-secret-2026',
  PORT:               process.env.PORT                       || 3000
};

const SALT_ROUNDS = 10;
const ADMIN_EMAIL = 'shruthir0413@gmail.com';
const LOG_FILE    = path.join(__dirname, 'activity_log.json');
const USERS_FILE  = path.join(__dirname, 'users.json');
const TG_FILE     = path.join(__dirname, 'tg_sessions.json');
const BACKUP_DIR  = path.join(__dirname, 'backups');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

let actLog     = [];
let users      = [];
let tgSessions = {};

try { actLog     = JSON.parse(fs.readFileSync(LOG_FILE,   'utf-8')); } catch {}
try { users      = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')); } catch {}
try { tgSessions = JSON.parse(fs.readFileSync(TG_FILE,    'utf-8')); } catch {}

// ── EXPRESS SETUP ──
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 3600000 }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// ── SESSION TIMEOUT MIDDLEWARE ──
app.use((req, res, next) => {
  if (req.session && req.session.loggedIn) {
    const now  = Date.now();
    const last = req.session.lastActivity || now;
    if (now - last > 3600000) {
      req.session.destroy();
      return res.status(401).json({ error: 'Session expired', sessionExpired: true });
    }
    req.session.lastActivity = now;
  }
  next();
});

// ── AUTO BACKUP ──
function doBackup() {
  try {
    const ts  = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(BACKUP_DIR, `log_${ts}.json`);
    if (fs.existsSync(LOG_FILE)) fs.copyFileSync(LOG_FILE, dst);
    const files = fs.readdirSync(BACKUP_DIR).sort().reverse();
    files.slice(10).forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {} });
  } catch (e) { console.error('Backup error:', e.message); }
}
setInterval(doBackup, 30 * 60 * 1000);

// ── LOGGING ──
function addLog(user, action) {
  const e = {
    time:      new Date().toLocaleTimeString(),
    date:      new Date().toLocaleDateString(),
    timestamp: new Date().toISOString(),
    user:      user || 'unknown',
    action
  };
  actLog.unshift(e);
  if (actLog.length > 200) actLog = actLog.slice(0, 200);
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(actLog, null, 2)); } catch {}
  console.log(`📋 [${e.time}] ${e.user}: ${action}`);
}

function saveUsers()     { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users,      null, 2)); } catch {} }
function saveTgSessions(){ try { fs.writeFileSync(TG_FILE,    JSON.stringify(tgSessions, null, 2)); } catch {} }

// ── NODEMAILER CACHE ──
const transporterCache = {};
function getTransporter(user, pass) {
  if (!transporterCache[user]) {
    transporterCache[user] = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user, pass },
      tls: { rejectUnauthorized: false },
      pool: true, maxConnections: 3, socketTimeout: 10000
    });
  }
  return transporterCache[user];
}

// ── ANTHROPIC AI ──
// FIX: use correct model name claude-haiku-4-5-20251001
async function callClaude(prompt, maxTokens = 300, imageBase64 = null) {
  if (!config.ANTHROPIC_API_KEY) return null;
  try {
    const content = imageBase64
      ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      : prompt;

    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content }]
    }, {
      headers: {
        'x-api-key':         config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      timeout: 30000
    });
    return r.data.content[0].text.trim();
  } catch (e) {
    console.error('Claude error:', e.response?.data?.error?.message || e.message);
    return null;
  }
}

async function summarizeEmail(body, subject, sender) {
  const clean = (body || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const prompt = `Summarize this email in 2 short plain sentences for voice reading. No bullet points, no special characters.\nFrom: ${sender}\nSubject: ${subject}\nBody: ${clean}\nReturn ONLY the summary.`;
  return (await callClaude(prompt, 100)) || clean.slice(0, 180);
}

async function getAISuggestions(body, sender, subject) {
  const clean  = (body || '').replace(/<[^>]*>/g, '').trim().slice(0, 400);
  const prompt = `Write 3 short one-sentence email reply suggestions.\nFrom: ${sender}\nSubject: ${subject}\nEmail: ${clean}\nReturn ONLY a JSON array: ["reply1","reply2","reply3"]`;
  const result = await callClaude(prompt, 150);
  if (!result) return fallbackReplies(body);
  try   { return JSON.parse(result.replace(/```json|```/g, '').trim()); }
  catch { return fallbackReplies(body); }
}

async function readImageInEmail(imageBase64) {
  const prompt = 'Read all text in this image. If no text, describe it briefly. Plain text only.';
  return (await callClaude(prompt, 200, imageBase64)) || 'Image could not be read.';
}

function fallbackReplies(body) {
  const b = (body || '').toLowerCase();
  if (b.includes('security') || b.includes('alert'))  return ['The sign-in was mine.', 'I did not do this.', 'Thank you for the alert.'];
  if (b.includes('bill')     || b.includes('invoice')) return ['Thank you, will review.', 'Invoice received.', 'Will process soon.'];
  if (b.includes('meeting'))                           return ['Confirmed, I will be there.', 'Thanks for the reminder.', 'Please share the link.'];
  return ['Thank you, will respond soon.', 'Got it, noted.', 'Will follow up shortly.'];
}

// ── GOOGLE OAUTH ──
function getOAuth() {
  return new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_REDIRECT_URI
  );
}

app.get('/auth/google', (req, res) => {
  const type = req.query.type || 'login';
  if (!config.GOOGLE_CLIENT_ID) {
    return res.send('<h2 style="font-family:sans-serif;padding:40px">Google Client ID missing in .env file. Add GOOGLE_CLIENT_ID to your .env and restart the server.</h2>');
  }
  req.session.oauthType = type;
  const oauth = getOAuth();
  const url   = oauth.generateAuthUrl({
    access_type: 'offline',
    scope:       config.GOOGLE_SCOPES,
    prompt:      'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    console.error('OAuth callback error:', error);
    return res.redirect('/app.html?error=auth_failed&reason=' + encodeURIComponent(error || 'no_code'));
  }
  try {
    const oauth          = getOAuth();
    const { tokens }     = await oauth.getToken(code);
    oauth.setCredentials(tokens);
    const { data: profile } = await google.oauth2({ version: 'v2', auth: oauth }).userinfo.get();
    const oauthType      = req.session.oauthType || 'login';

    req.session.googleTokens  = tokens;
    req.session.googleUser    = { email: profile.email, name: profile.name };
    req.session.loggedIn      = true;
    req.session.userRole      = 'user';
    req.session.lastActivity  = Date.now();

    let u = users.find(u => u.email === profile.email);
    if (!u) {
      u = { email: profile.email, name: profile.name, pin: null, createdAt: new Date().toISOString(), emailsSent: 0, lastLogin: null };
      users.push(u);
    }
    u.lastLogin = new Date().toISOString();
    saveUsers();
    addLog(profile.email, `User ${oauthType === 'signup' ? 'signed up' : 'logged in'} via Google OAuth`);

    // If new user or no PIN set → go to PIN setup
    if (oauthType === 'signup' || !u.pin) return res.redirect('/app.html?step=setpin');
    return res.redirect('/app.html?step=lang');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    return res.redirect('/app.html?error=auth_failed&reason=' + encodeURIComponent(err.message));
  }
});

app.get('/auth/logout', (req, res) => {
  const email = req.session.googleUser?.email || req.session.gmailUser;
  if (email) addLog(email, 'User signed out');
  req.session.destroy(() => res.redirect('/app.html'));
});

// ── AUTH STATUS ──
app.get('/api/auth/status', (req, res) => {
  if (req.session.loggedIn) {
    const email = req.session.googleUser?.email || req.session.gmailUser;
    const name  = req.session.googleUser?.name  || email?.split('@')[0] || 'User';
    res.json({ loggedIn: true, user: { email, name }, role: req.session.userRole || 'user' });
  } else {
    res.json({ loggedIn: false, user: null });
  }
});

// ── PIN MANAGEMENT ──
app.post('/api/user/setpin', async (req, res) => {
  if (!req.session.googleUser && !req.session.gmailUser) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const { pin } = req.body;
  if (!pin || String(pin).length !== 4 || !/^\d{4}$/.test(String(pin))) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
  }
  try {
    const hashed = await bcrypt.hash(String(pin), SALT_ROUNDS);
    const email  = req.session.googleUser?.email || req.session.gmailUser;
    let u = users.find(u => u.email === email);
    if (!u) {
      u = { email, name: email.split('@')[0], pin: null, createdAt: new Date().toISOString(), emailsSent: 0 };
      users.push(u);
    }
    u.pin = hashed;
    saveUsers();
    addLog(email, 'PIN set successfully');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// FIX: Admin also needs to be able to verify PIN
// Admin PIN is stored directly — admin uses App Password not bcrypt PIN
app.post('/api/user/verifypin', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const { pin } = req.body;
  const email   = req.session.googleUser?.email || req.session.gmailUser;

  // Admin uses a fixed PIN "0413" stored in session or env
  if (req.session.userRole === 'admin') {
    const adminPin = process.env.ADMIN_PIN || '0413';
    return res.json({ valid: String(pin) === String(adminPin) });
  }

  const u = users.find(u => u.email === email);
  if (!u || !u.pin) return res.json({ valid: false, error: 'No PIN set for this user' });

  try {
    const match = await bcrypt.compare(String(pin), u.pin);
    res.json({ valid: match });
  } catch {
    res.json({ valid: false });
  }
});

// ── ADMIN LOGIN via IMAP ──
function verifyIMAP(user, pass) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user, password: pass,
      host: 'imap.gmail.com', port: 993, tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000, authTimeout: 10000
    });
    imap.once('ready', () => { imap.end(); resolve(true); });
    imap.once('error', err => reject(err));
    imap.connect();
  });
}

app.post('/api/admin/login', async (req, res) => {
  let { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'Email and password required' });
  email    = email.trim().toLowerCase();
  password = password.trim().replace(/\s/g, '');

  if (email !== ADMIN_EMAIL) {
    addLog(email, '❌ Admin login rejected — wrong email');
    return res.status(403).json({ success: false, error: 'Access denied. Only the registered admin can login here.' });
  }
  try {
    await verifyIMAP(email, password);
    req.session.gmailUser     = email;
    req.session.gmailPassword = password;
    req.session.loggedIn      = true;
    req.session.userRole      = 'admin';
    req.session.lastActivity  = Date.now();
    addLog(email, 'Admin logged in via IMAP');

    // Ensure admin exists in users list
    let u = users.find(u => u.email === email);
    if (!u) {
      u = { email, name: 'Admin', pin: null, createdAt: new Date().toISOString(), emailsSent: 0, lastLogin: null };
      users.push(u);
    }
    u.lastLogin = new Date().toISOString();
    saveUsers();

    res.json({ success: true, email, name: 'Admin', role: 'admin' });
  } catch (err) {
    const msg = err.message?.toLowerCase().includes('auth') ? 'Wrong App Password.' : err.message;
    addLog(email, '❌ Admin login failed: ' + msg);
    res.status(401).json({ success: false, error: 'Login failed. ' + msg + ' Get App Password from myaccount.google.com/apppasswords' });
  }
});

// ── GMAIL CLIENT FACTORY ──
function getGmailClient(req) {
  if (req.session.googleTokens) {
    const oauth = getOAuth();
    oauth.setCredentials(req.session.googleTokens);
    return { type: 'oauth', gmail: google.gmail({ version: 'v1', auth: oauth }) };
  }
  if (req.session.gmailPassword) {
    return { type: 'imap', user: req.session.gmailUser, pass: req.session.gmailPassword };
  }
  return null;
}

function decB64(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function getBodyAndImages(payload) {
  let text = '', images = [];
  function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data)          text += decB64(p.body.data);
    if (p.mimeType?.startsWith('image/') && p.body?.data)     images.push(p.body.data);
    if (p.parts) p.parts.forEach(walk);
  }
  walk(payload);
  return { text: text.slice(0, 2000), images };
}

function hdr(headers, name) {
  return (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
}

// ── FETCH LATEST EMAIL ──
app.get('/api/gmail/latest', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in', sessionExpired: true });
  const tab    = req.query.tab || 'inbox';
  const client = getGmailClient(req);
  if (!client) return res.status(401).json({ error: 'No Gmail connection', sessionExpired: true });

  try {
    if (client.type === 'oauth') {
      const labelMap = { inbox: ['INBOX'], social: ['INBOX','CATEGORY_SOCIAL'], promotions: ['INBOX','CATEGORY_PROMOTIONS'] };
      const list = await client.gmail.users.messages.list({ userId: 'me', maxResults: 1, labelIds: labelMap[tab] || ['INBOX'] });
      if (!list.data.messages?.length) return res.json({ email: null });

      const msg  = await client.gmail.users.messages.get({ userId: 'me', id: list.data.messages[0].id, format: 'full' });
      const hdrs = msg.data.payload.headers;
      const { text, images } = getBodyAndImages(msg.data.payload);

      let imageText = '';
      if (images.length > 0) imageText = await readImageInEmail(images[0]);

      const fullBody = text + (imageText ? ' Image says: ' + imageText : '');
      const fromText = hdr(hdrs, 'From');
      const subject  = hdr(hdrs, 'Subject');
      const [summary, replies] = await Promise.all([
        summarizeEmail(fullBody, subject, fromText),
        getAISuggestions(fullBody, fromText, subject)
      ]);

      // Mark as read
      try { await client.gmail.users.messages.modify({ userId: 'me', id: msg.data.id, requestBody: { removeLabelIds: ['UNREAD'] } }); } catch {}

      const email = { id: msg.data.id, from: fromText, subject, date: hdr(hdrs, 'Date') ? new Date(hdr(hdrs, 'Date')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '', summary, replies, hasImage: images.length > 0, imageText, read: true };
      addLog(req.session.googleUser?.email || req.session.gmailUser, `Read: ${subject}`);
      return res.json({ email });
    } else {
      const emails = await fetchIMAP(client.user, client.pass, tab, 1);
      if (!emails.length) return res.json({ email: null });
      const e = emails[0];
      const [summary, replies] = await Promise.all([
        summarizeEmail(e.body, e.subject, e.from),
        getAISuggestions(e.body, e.from, e.subject)
      ]);
      addLog(client.user, `Read: ${e.subject}`);
      return res.json({ email: { ...e, summary, replies, hasImage: false, imageText: '' } });
    }
  } catch (err) {
    console.error('Latest email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FETCH EMAIL LIST ──
app.get('/api/gmail/emails', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in', emails: [] });
  const tab    = req.query.tab || 'inbox';
  const limit  = Math.min(parseInt(req.query.maxResults) || 5, 10);
  const client = getGmailClient(req);
  if (!client) return res.status(401).json({ error: 'No Gmail connection', emails: [] });

  try {
    let emails = [];
    if (client.type === 'oauth') {
      const labelMap = { inbox: ['INBOX'], social: ['INBOX','CATEGORY_SOCIAL'], promotions: ['INBOX','CATEGORY_PROMOTIONS'] };
      const list = await client.gmail.users.messages.list({ userId: 'me', maxResults: limit, labelIds: labelMap[tab] || ['INBOX'] });
      const msgs = list.data.messages || [];
      emails = await Promise.all(msgs.map(async ({ id }) => {
        const msg  = await client.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const hdrs = msg.data.payload.headers;
        const { text } = getBodyAndImages(msg.data.payload);
        return {
          id, from: hdr(hdrs, 'From'), subject: hdr(hdrs, 'Subject'),
          date:    hdr(hdrs, 'Date') ? new Date(hdr(hdrs, 'Date')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
          snippet: msg.data.snippet || '', body: text,
          read:    !(msg.data.labelIds || []).includes('UNREAD')
        };
      }));
    } else {
      emails = await fetchIMAP(client.user, client.pass, tab, limit);
    }
    addLog(req.session.googleUser?.email || req.session.gmailUser, `Fetched ${emails.length} emails (${tab})`);
    res.json({ emails });
  } catch (err) {
    res.status(500).json({ error: err.message, emails: [] });
  }
});

// ── COUNT EMAILS (all 3 sections) ──
app.get('/api/gmail/count', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const client = getGmailClient(req);
  if (!client) return res.status(401).json({ error: 'No connection' });

  try {
    if (client.type === 'oauth') {
      const labelMap = { inbox: ['INBOX'], social: ['INBOX','CATEGORY_SOCIAL'], promotions: ['INBOX','CATEGORY_PROMOTIONS'] };
      const results  = {};
      await Promise.all(['inbox','social','promotions'].map(async tab => {
        const [all, unread] = await Promise.all([
          client.gmail.users.messages.list({ userId: 'me', labelIds: labelMap[tab],                     maxResults: 1 }),
          client.gmail.users.messages.list({ userId: 'me', labelIds: [...labelMap[tab], 'UNREAD'],      maxResults: 1 })
        ]);
        const total   = all.data.resultSizeEstimate    || 0;
        const unreadN = unread.data.resultSizeEstimate || 0;
        results[tab]  = { total, unread: unreadN, read: Math.max(0, total - unreadN) };
      }));
      res.json({ sections: results });
    } else {
      const all = await fetchIMAP(client.user, client.pass, 'inbox', 50);
      const u   = all.filter(e => !e.read).length;
      res.json({ sections: { inbox: { total: all.length, unread: u, read: all.length - u }, social: { total: 0, unread: 0, read: 0 }, promotions: { total: 0, unread: 0, read: 0 } } });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CLEAR TRASH ──
app.post('/api/gmail/cleartrash', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const client = getGmailClient(req);
  if (!client) return res.status(400).json({ error: 'No Gmail connection' });

  try {
    if (client.type === 'oauth') {
      const list = await client.gmail.users.messages.list({ userId: 'me', labelIds: ['TRASH'], maxResults: 500 });
      const msgs = list.data.messages || [];
      if (!msgs.length) return res.json({ success: true, cleared: 0 });
      await client.gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids: msgs.map(m => m.id) } });
      addLog(req.session.googleUser?.email, `🗑️ Cleared ${msgs.length} trash emails`);
      return res.json({ success: true, cleared: msgs.length });
    } else {
      // IMAP: move all INBOX+Trash to deleted
      return res.json({ success: false, error: 'Clear trash requires OAuth login, not admin IMAP login.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEND EMAIL ──
app.post('/api/gmail/send', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'Missing to, subject, or body' });
  const fromEmail = req.session.googleUser?.email || req.session.gmailUser;
  try {
    const client = getGmailClient(req);
    if (client?.type === 'oauth') {
      const raw = Buffer.from([`From:${fromEmail}`,`To:${to}`,`Subject:${subject}`,'MIME-Version:1.0','Content-Type:text/plain;charset=utf-8','',body].join('\r\n'))
        .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      await client.gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    } else {
      const t = getTransporter(req.session.gmailUser, req.session.gmailPassword);
      await Promise.race([
        t.sendMail({ from: fromEmail, to, subject, text: body }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Send timeout')), 15000))
      ]);
    }
    const u = users.find(u => u.email === fromEmail);
    if (u) { u.emailsSent = (u.emailsSent || 0) + 1; saveUsers(); }
    addLog(fromEmail, `✅ Sent email to: ${to} — ${subject}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── IMAP HELPERS ──
function fetchIMAP(user, pass, tab, limit) {
  return new Promise((resolve, reject) => {
    const folderMap = { inbox: 'INBOX', social: '[Gmail]/Social', promotions: '[Gmail]/Promotions' };
    const folder    = folderMap[tab] || 'INBOX';
    const imap      = new Imap({ user, password: pass, host: 'imap.gmail.com', port: 993, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 20000, authTimeout: 15000 });
    imap.once('error', reject);
    imap.once('ready', () => {
      imap.openBox(folder, true, (err, box) => {
        if (err) {
          imap.openBox('INBOX', true, (err2, box2) => {
            if (err2) { imap.end(); return reject(err2); }
            doImapFetch(imap, box2, limit, resolve, reject);
          });
        } else doImapFetch(imap, box, limit, resolve, reject);
      });
    });
    imap.connect();
  });
}

function doImapFetch(imap, box, limit, resolve, reject) {
  const total = box.messages.total;
  if (total === 0) { imap.end(); return resolve([]); }
  const start = Math.max(1, total - limit + 1);
  const f     = imap.seq.fetch(`${start}:${total}`, { bodies: ['HEADER','TEXT'], markSeen: false });
  const msgs  = [];
  f.on('message', (msg) => {
    const m = { header: '', body: '', attrs: {} };
    msg.on('body', (stream, info) => {
      let buf = '';
      stream.on('data',    d  => buf += d.toString('utf8'));
      stream.once('end',   () => { if (info.which === 'HEADER') m.header = buf; else m.body += buf; });
    });
    msg.once('attributes', a => m.attrs = a);
    msg.once('end',        () => msgs.push(m));
  });
  f.once('error', err => { imap.end(); reject(err); });
  f.once('end',   () => {
    imap.end();
    Promise.all(msgs.map(async m => {
      try {
        const parsed = await simpleParser(m.header + '\r\n\r\n' + m.body.slice(0, 3000));
        const flags  = m.attrs.flags || [];
        const isRead = flags.some(f => f === '\\Seen' || f.toLowerCase() === '\\seen');
        const body   = (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        return { id: String(m.attrs.uid || m.seqno || Date.now()), from: parsed.from?.text || 'Unknown', subject: parsed.subject || '(No Subject)', date: parsed.date ? new Date(parsed.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '', body, snippet: body.slice(0, 100), read: isRead };
      } catch { return null; }
    })).then(r => resolve(r.filter(Boolean).reverse())).catch(reject);
  });
}

// ── AI SUGGEST ENDPOINT ──
app.post('/api/ai/suggest', async (req, res) => {
  const { emailContent, sender, subject } = req.body;
  res.json({ suggestions: await getAISuggestions(emailContent, sender, subject) });
});

// ── AI BOT CHAT ──
app.post('/api/ai/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  if (!config.ANTHROPIC_API_KEY) return res.json({ reply: 'AI not configured. Add ANTHROPIC_API_KEY to your .env file.' });
  try {
    const messages = [...(history || []).slice(-8), { role: 'user', content: message }];
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system:     'You are a helpful AI assistant inside VoiceMailAssist. Keep answers short and clear — 2 sentences max — because they will be read aloud.',
      messages
    }, { headers: { 'x-api-key': config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 });
    res.json({ reply: r.data.content[0].text.trim() });
  } catch (e) {
    res.status(500).json({ reply: 'Sorry, I could not process that right now.' });
  }
});

// ── TELEGRAM MTProto ──
const tgClients      = {};
const tgCodeRequests = {};

app.post('/api/telegram/mtproto/start', async (req, res) => {
  const { phone } = req.body;
  if (!phone)                    return res.status(400).json({ error: 'Phone number required' });
  if (!config.TELEGRAM_API_ID)  return res.status(400).json({ error: 'TELEGRAM_API_ID not set in .env' });
  if (!config.TELEGRAM_API_HASH) return res.status(400).json({ error: 'TELEGRAM_API_HASH not set in .env' });

  const sessionKey   = phone.replace(/\D/g, '');
  const savedSession = tgSessions[sessionKey] || '';

  try {
    const client = new TelegramClient(
      new StringSession(savedSession),
      config.TELEGRAM_API_ID,
      config.TELEGRAM_API_HASH,
      { connectionRetries: 5, useWSS: false }
    );
    await client.connect();

    if (await client.isUserAuthorized()) {
      tgClients[sessionKey]      = client;
      req.session.tgSession      = sessionKey;
      req.session.tgPhone        = phone;
      addLog(req.session.googleUser?.email || 'user', `Telegram MTProto reconnected: ${phone}`);
      return res.json({ success: true, needCode: false });
    }

    const result = await client.sendCode({ apiId: config.TELEGRAM_API_ID, apiHash: config.TELEGRAM_API_HASH }, phone);
    tgClients[sessionKey]      = client;
    tgCodeRequests[sessionKey] = result.phoneCodeHash;
    req.session.tgSession      = sessionKey;
    req.session.tgPhone        = phone;
    res.json({ success: true, needCode: true });
  } catch (err) {
    console.error('TG start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/telegram/mtproto/verify', async (req, res) => {
  const { code, phone, password } = req.body;
  const sessionKey = (phone || req.session.tgPhone || '').replace(/\D/g, '');
  const client     = tgClients[sessionKey];
  const codeHash   = tgCodeRequests[sessionKey];
  if (!client) return res.status(400).json({ error: 'No session found. Start again.' });

  try {
    await client.invoke(new (require('telegram/tl').Api.auth.SignIn)({
      phoneNumber:   phone || req.session.tgPhone,
      phoneCodeHash: codeHash || '',
      phoneCode:     code
    }));
    const session          = client.session.save();
    tgSessions[sessionKey] = session;
    saveTgSessions();
    req.session.tgSession  = sessionKey;
    addLog(req.session.googleUser?.email || 'user', `Telegram verified: ${phone}`);
    res.json({ success: true });
  } catch (err) {
    // Handle 2FA
    if (err.message?.includes('SESSION_PASSWORD_NEEDED') || err.message?.includes('2FA')) {
      if (!password) return res.json({ success: false, need2FA: true });
      try {
        await client.signInWithPassword({ apiId: config.TELEGRAM_API_ID, apiHash: config.TELEGRAM_API_HASH }, { password: async () => password });
        const session          = client.session.save();
        tgSessions[sessionKey] = session;
        saveTgSessions();
        req.session.tgSession  = sessionKey;
        return res.json({ success: true });
      } catch (e2) {
        return res.status(400).json({ error: '2FA password wrong: ' + e2.message });
      }
    }
    console.error('TG verify error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/telegram/mtproto/chats', async (req, res) => {
  const sessionKey = req.session.tgSession;
  const client     = tgClients[sessionKey];
  if (!client) return res.status(401).json({ error: 'Not connected to Telegram. Please login first.' });
  try {
    const dialogs = await client.getDialogs({ limit: 30 });
    res.json({ chats: dialogs.map(d => ({ id: String(d.id), name: d.title || d.name || 'Unknown', unread: d.unreadCount || 0, lastMsg: d.message?.message || '', lastDate: d.message?.date ? new Date(d.message.date * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '' })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/telegram/mtproto/messages', async (req, res) => {
  const sessionKey = req.session.tgSession;
  const client     = tgClients[sessionKey];
  const { chatId } = req.query;
  if (!client) return res.status(401).json({ error: 'Not connected' });
  try {
    const messages = await client.getMessages(chatId, { limit: 30 });
    const me       = await client.getMe();
    res.json({ messages: messages.reverse().map(m => ({ id: m.id, text: m.message || '', fromMe: String(m.fromId?.userId) === String(me.id), date: m.date ? new Date(m.date * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '' })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/telegram/mtproto/send', async (req, res) => {
  const sessionKey      = req.session.tgSession;
  const client          = tgClients[sessionKey];
  const { chatId, message } = req.body;
  if (!client)  return res.status(401).json({ error: 'Not connected' });
  if (!message) return res.status(400).json({ error: 'No message' });
  try {
    await client.sendMessage(chatId, { message });
    addLog(req.session.googleUser?.email || req.session.gmailUser || 'user', `✅ TG sent to: ${chatId}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN ROUTES ──
function requireAdmin(req, res, next) {
  if (req.session.userRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

app.post('/api/admin/log', (req, res) => {
  const { user, action } = req.body;
  if (action) addLog(user || req.session.gmailUser || 'browser', action);
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, (_, res) => {
  const c = kw => actLog.filter(e => e.action.toLowerCase().includes(kw)).length;
  res.json({ totalUsers: users.length, emailsSent: c('sent email'), tgMessages: c('tg sent'), pinSuccess: c('pin set') + c('pin verified'), pinFailed: c('pin failed') + c('blocked'), totalLogins: c('logged in'), totalActivities: actLog.length });
});

app.get('/api/admin/logs',          requireAdmin, (_, res) => res.json({ logs: actLog.slice(0, 50), total: actLog.length }));
app.get('/api/admin/users',         requireAdmin, (_, res) => res.json({ users: users.map(u => ({ email: u.email, name: u.name, emailsSent: u.emailsSent || 0, lastLogin: u.lastLogin || 'Never', hasPin: !!u.pin, createdAt: u.createdAt || 'Unknown' })) }));
app.get('/api/admin/export-logs',   requireAdmin, (_, res) => res.json(actLog));
app.get('/api/admin/status',                      (_, res) => res.json({ server: 'online', gmail: true, telegram: !!(config.TELEGRAM_BOT_TOKEN), uptime: process.uptime(), nodeVersion: process.version, timestamp: new Date().toISOString() }));
app.get('/api/admin/analytics',     requireAdmin, (_, res) => {
  const byUser = {};
  actLog.forEach(e => {
    if (!byUser[e.user]) byUser[e.user] = { logins: 0, emailsSent: 0, tgSent: 0 };
    const a = e.action.toLowerCase();
    if (a.includes('logged in'))  byUser[e.user].logins++;
    if (a.includes('sent email')) byUser[e.user].emailsSent++;
    if (a.includes('tg sent'))    byUser[e.user].tgSent++;
  });
  res.json({ byUser, total: actLog.length });
});

app.delete('/api/admin/users/:email', requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email);
  users       = users.filter(u => u.email !== email);
  saveUsers();
  addLog(req.session.gmailUser, `Admin removed user: ${email}`);
  res.json({ ok: true });
});

// ── START SERVER ──
const PORT = config.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`  ✅  VoiceMailAssist v5 — Running on port ${PORT}`);
  console.log(`  🌐  http://localhost:${PORT}/app.html`);
  console.log(`  🔐  Admin: ${ADMIN_EMAIL} + App Password`);
  console.log(`  👤  Users: Google OAuth`);
  console.log(`  ⏱️   Session: 60 min timeout`);
  console.log(`  💾  Backup: every 30 min`);
  console.log(`  🤖  AI: ${config.ANTHROPIC_API_KEY ? '✅ Connected' : '❌ No API key — add to .env'}`);
  console.log(`  ✈️   Telegram: ${config.TELEGRAM_API_ID ? '✅ MTProto ready' : '❌ No API ID — add to .env'}`);
  console.log(`  🔑  Google OAuth: ${config.GOOGLE_CLIENT_ID ? '✅ Configured' : '❌ Missing — add to .env'}`);
  console.log(`══════════════════════════════════════════════════════\n`);
  if (!config.GOOGLE_CLIENT_ID) console.warn('⚠️  WARNING: GOOGLE_CLIENT_ID missing from .env — OAuth login will fail');
  if (!config.ANTHROPIC_API_KEY) console.warn('⚠️  WARNING: ANTHROPIC_API_KEY missing — AI features disabled');
});
