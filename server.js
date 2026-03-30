require('dotenv').config();
const express       = require('express');
const session       = require('express-session');
const cors          = require('cors');
const path          = require('path');
const fs            = require('fs');
const axios         = require('axios');
const nodemailer    = require('nodemailer');
const Imap          = require('node-imap');
const { simpleParser } = require('mailparser');
const { google }    = require('googleapis');
const bcrypt        = require('bcrypt');
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');

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
  TELEGRAM_BOT_TOKEN:  process.env.TELEGRAM_BOT_TOKEN  || '',
  TELEGRAM_CHAT_ID:    process.env.TELEGRAM_CHAT_ID    || '',
  TELEGRAM_API_ID:     parseInt(process.env.TELEGRAM_API_ID) || 0,
  TELEGRAM_API_HASH:   process.env.TELEGRAM_API_HASH   || '',
  ANTHROPIC_API_KEY:   process.env.ANTHROPIC_API_KEY   || '',
  SESSION_SECRET:      process.env.SESSION_SECRET       || 'vma-secret-2026',
  PORT:                process.env.PORT                 || 3000
};

const SALT_ROUNDS  = 10;
const ADMIN_EMAIL  = 'shruthir0413@gmail.com';
const LOG_FILE     = path.join(__dirname, 'activity_log.json');
const USERS_FILE   = path.join(__dirname, 'users.json');
const TG_FILE      = path.join(__dirname, 'tg_sessions.json');
const BACKUP_DIR   = path.join(__dirname, 'backups');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

let actLog  = [];
let users   = [];
let tgSessions = {};

try { actLog     = JSON.parse(fs.readFileSync(LOG_FILE,   'utf-8')); } catch {}
try { users      = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')); } catch {}
try { tgSessions = JSON.parse(fs.readFileSync(TG_FILE,    'utf-8')); } catch {}

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

// ── SESSION TIMEOUT ──
app.use((req, res, next) => {
  if (req.session && req.session.loggedIn) {
    const now = Date.now();
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
    const dst = path.join(BACKUP_DIR, `activity_log_${ts}.json`);
    if (fs.existsSync(LOG_FILE)) fs.copyFileSync(LOG_FILE, dst);
    const files = fs.readdirSync(BACKUP_DIR).sort().reverse();
    files.slice(10).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  } catch (e) { console.error('Backup error:', e.message); }
}
setInterval(doBackup, 30 * 60 * 1000);

// ── HELPERS ──
function addLog(user, action) {
  const e = {
    time: new Date().toLocaleTimeString(),
    date: new Date().toLocaleDateString(),
    timestamp: new Date().toISOString(),
    user: user || 'unknown',
    action
  };
  actLog.unshift(e);
  if (actLog.length > 200) actLog = actLog.slice(0, 200);
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(actLog, null, 2)); } catch {}
  console.log(`📋 [${e.time}] ${e.user}: ${action}`);
}

function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch {}
}

function saveTgSessions() {
  try { fs.writeFileSync(TG_FILE, JSON.stringify(tgSessions, null, 2)); } catch {}
}

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
async function callClaude(prompt, maxTokens = 300, imageBase64 = null) {
  if (!config.ANTHROPIC_API_KEY) return null;
  try {
    const content = imageBase64
      ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt }
        ]
      : [{ type: 'text', text: prompt }];

    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }]
    }, {
      headers: {
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });
    return r.data.content[0].text.trim();
  } catch (e) {
    console.error('Claude error:', e.message);
    return null;
  }
}

async function summarizeEmail(body, subject, sender) {
  const prompt = `Summarize this email in exactly 2 short sentences. Write naturally for text to speech — no bullet points, no markdown, no special characters. Just plain conversational sentences.\nFrom: ${sender}\nSubject: ${subject}\nBody: ${(body || '').slice(0, 800)}\nReturn ONLY the 2 sentence summary, nothing else.`;
  const result = await callClaude(prompt, 150);
  return result || (body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function getAISuggestions(body, sender, subject) {
  const prompt = `Generate exactly 3 short professional email reply suggestions. Each must be one sentence only. Natural and conversational.\nFrom: ${sender}\nSubject: ${subject}\nEmail: ${(body || '').slice(0, 400)}\nReturn ONLY a JSON array like this: ["reply one","reply two","reply three"]`;
  const result = await callClaude(prompt, 200);
  if (!result) return fallbackReplies(body);
  try {
    return JSON.parse(result.replace(/```json|```/g, '').trim());
  } catch {
    return fallbackReplies(body);
  }
}

async function readImageInEmail(imageBase64) {
  const prompt = 'Read all text visible in this image. If there is no text, describe what you see in one sentence. Return plain text only, no markdown.';
  const result = await callClaude(prompt, 300, imageBase64);
  return result || 'Image content could not be read.';
}

function fallbackReplies(body) {
  const b = (body || '').toLowerCase();
  if (b.includes('security') || b.includes('alert'))  return ['The sign-in was mine.', 'I did not do this.', 'Thank you for the alert.'];
  if (b.includes('bill')     || b.includes('invoice')) return ['Thank you, will review.', 'Invoice received.', 'Will process soon.'];
  if (b.includes('meeting'))                           return ['Confirmed, I will be there.', 'Thanks for the reminder.', 'Please share the link.'];
  return ['Thank you, will respond soon.', 'Got it, noted.', 'Will follow up shortly.'];
}

// ── GOOGLE OAUTH ──
function getOAuth(redirectUri) {
  return new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    redirectUri || config.GOOGLE_REDIRECT_URI
  );
}

app.get('/auth/google', (req, res) => {
  const type = req.query.type || 'login';
  req.session.oauthType = type;
  if (!config.GOOGLE_CLIENT_ID) return res.send('<h2>Add Google credentials to .env</h2>');
  const oauth = getOAuth();
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    scope: config.GOOGLE_SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/app.html?error=auth_failed');
  try {
    const oauth = getOAuth();
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);
    const { data: profile } = await google.oauth2({ version: 'v2', auth: oauth }).userinfo.get();
    const oauthType = req.session.oauthType || 'login';

    req.session.googleTokens = tokens;
    req.session.googleUser   = { email: profile.email, name: profile.name };
    req.session.loggedIn     = true;
    req.session.userRole     = 'user';
    req.session.lastActivity = Date.now();

    let u = users.find(u => u.email === profile.email);
    if (!u) {
      u = { email: profile.email, name: profile.name, pin: null, createdAt: new Date().toISOString(), emailsSent: 0, lastLogin: null };
      users.push(u);
    }
    u.lastLogin = new Date().toISOString();
    saveUsers();
    addLog(profile.email, `User ${oauthType === 'signup' ? 'signed up' : 'logged in'} via Google OAuth`);

    if (oauthType === 'signup' || !u.pin) return res.redirect('/app.html?step=setpin');
    return res.redirect('/app.html?step=lang');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/app.html?error=auth_failed');
  }
});

// ── PIN MANAGEMENT (bcrypt) ──
app.post('/api/user/setpin', async (req, res) => {
  if (!req.session.googleUser) return res.status(401).json({ error: 'Not logged in' });
  const { pin } = req.body;
  if (!pin || String(pin).length !== 4) return res.status(400).json({ error: 'PIN must be 4 digits' });
  try {
    const hashed = await bcrypt.hash(String(pin), SALT_ROUNDS);
    const u = users.find(u => u.email === req.session.googleUser.email);
    if (u) { u.pin = hashed; saveUsers(); }
    req.session.userPIN = hashed;
    addLog(req.session.googleUser.email, 'User set security PIN');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/user/verifypin', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const { pin } = req.body;
  const email = req.session.googleUser?.email || req.session.gmailUser;
  const u = users.find(u => u.email === email);
  if (!u || !u.pin) return res.json({ valid: false });
  try {
    const match = await bcrypt.compare(String(pin), u.pin);
    res.json({ valid: match });
  } catch {
    res.json({ valid: false });
  }
});

app.get('/api/user/pin', (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  res.json({ hashed: true });
});

app.get('/api/auth/status', (req, res) => {
  if (req.session.loggedIn) {
    const email = req.session.googleUser?.email || req.session.gmailUser;
    const name  = req.session.googleUser?.name  || email?.split('@')[0];
    res.json({ loggedIn: true, user: { email, name }, role: req.session.userRole || 'user' });
  } else {
    res.json({ loggedIn: false, user: null });
  }
});

app.get('/auth/logout', (req, res) => {
  const email = req.session.googleUser?.email || req.session.gmailUser;
  if (email) addLog(email, 'User signed out');
  req.session.destroy(() => res.redirect('/app.html'));
});

// ── ADMIN LOGIN ──
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
  password = password.replace(/\s/g, '');
  if (email !== ADMIN_EMAIL) {
    addLog(email, '❌ Admin login rejected — unauthorized email');
    return res.status(403).json({ success: false, error: 'Access denied.' });
  }
  try {
    await verifyIMAP(email, password);
    req.session.gmailUser     = email;
    req.session.gmailPassword = password;
    req.session.loggedIn      = true;
    req.session.userRole      = 'admin';
    req.session.lastActivity  = Date.now();
    addLog(email, 'Admin logged in via IMAP');
    res.json({ success: true, email, name: 'Admin', role: 'admin' });
  } catch (err) {
    res.status(401).json({ success: false, error: 'Login failed. Check your App Password.' });
  }
});

// ── GMAIL CLIENT ──
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
  let text = '';
  let images = [];
  function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data) text += decB64(p.body.data);
    if (p.mimeType?.startsWith('image/') && p.body?.data) images.push(p.body.data);
    if (p.parts) p.parts.forEach(walk);
  }
  walk(payload);
  return { text: text.slice(0, 2000), images };
}

function hdr(headers, name) {
  return (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
}

// ── FETCH LATEST EMAIL (single email with AI summary + image reading) ──
app.get('/api/gmail/latest', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in', sessionExpired: true });
  const tab    = req.query.tab || 'inbox';
  const client = getGmailClient(req);
  if (!client) return res.status(401).json({ error: 'No Gmail connection' });

  try {
    let email = null;

    if (client.type === 'oauth') {
      const labelMap = {
        inbox:      ['INBOX'],
        social:     ['INBOX', 'CATEGORY_SOCIAL'],
        promotions: ['INBOX', 'CATEGORY_PROMOTIONS']
      };
      const list = await client.gmail.users.messages.list({
        userId: 'me', maxResults: 1,
        labelIds: labelMap[tab] || ['INBOX']
      });
      if (!list.data.messages?.length) return res.json({ email: null });

      const msg  = await client.gmail.users.messages.get({ userId: 'me', id: list.data.messages[0].id, format: 'full' });
      const hdrs = msg.data.payload.headers;
      const { text, images } = getBodyAndImages(msg.data.payload);

      let imageText = '';
      if (images.length > 0) {
        imageText = await readImageInEmail(images[0]);
      }

      const fullBody = text + (imageText ? '\n\nImage content: ' + imageText : '');
      const fromText = hdr(hdrs, 'From');
      const subject  = hdr(hdrs, 'Subject');
      const summary  = await summarizeEmail(fullBody, subject, fromText);
      const replies  = await getAISuggestions(fullBody, fromText, subject);

      email = {
        id:       msg.data.id,
        from:     fromText,
        subject,
        date:     hdr(hdrs, 'Date') ? new Date(hdr(hdrs, 'Date')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
        summary,
        replies,
        hasImage: images.length > 0,
        imageText,
        read:     !(msg.data.labelIds || []).includes('UNREAD')
      };

      await client.gmail.users.messages.modify({ userId: 'me', id: msg.data.id, requestBody: { removeLabelIds: ['UNREAD'] } });
    } else {
      const emails = await fetchIMAP(client.user, client.pass, tab, 1);
      if (!emails.length) return res.json({ email: null });
      const e       = emails[0];
      const summary = await summarizeEmail(e.body, e.subject, e.from);
      const replies = await getAISuggestions(e.body, e.from, e.subject);
      email = { ...e, summary, replies, hasImage: false, imageText: '' };
    }

    const userEmail = req.session.googleUser?.email || req.session.gmailUser;
    addLog(userEmail, `Read: ${email.subject}`);
    res.json({ email });
  } catch (err) {
    console.error('Latest email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── FETCH EMAILS (list) ──
app.get('/api/gmail/emails', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in', emails: [] });
  const tab    = req.query.tab || 'inbox';
  const limit  = parseInt(req.query.maxResults) || 5;
  const client = getGmailClient(req);
  if (!client) return res.status(401).json({ error: 'No Gmail connection', emails: [] });

  try {
    let emails = [];
    if (client.type === 'oauth') {
      const labelMap = {
        inbox:      ['INBOX'],
        social:     ['INBOX', 'CATEGORY_SOCIAL'],
        promotions: ['INBOX', 'CATEGORY_PROMOTIONS']
      };
      const list = await client.gmail.users.messages.list({ userId: 'me', maxResults: limit, labelIds: labelMap[tab] || ['INBOX'] });
      const msgs = list.data.messages || [];
      emails = await Promise.all(msgs.map(async ({ id }) => {
        const msg  = await client.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const hdrs = msg.data.payload.headers;
        const { text } = getBodyAndImages(msg.data.payload);
        return {
          id,
          from:    hdr(hdrs, 'From'),
          subject: hdr(hdrs, 'Subject'),
          date:    hdr(hdrs, 'Date') ? new Date(hdr(hdrs, 'Date')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
          snippet: msg.data.snippet || '',
          body:    text,
          read:    !(msg.data.labelIds || []).includes('UNREAD')
        };
      }));
    } else {
      emails = await fetchIMAP(client.user, client.pass, tab, limit);
    }
    const userEmail = req.session.googleUser?.email || req.session.gmailUser;
    addLog(userEmail, `Fetched ${emails.length} emails (${tab})`);
    res.json({ emails });
  } catch (err) {
    res.status(500).json({ error: err.message, emails: [] });
  }
});

// ── COUNT EMAILS (all sections) ──
app.get('/api/gmail/count', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const client = getGmailClient(req);
  if (!client) return res.status(401).json({ error: 'No connection' });

  try {
    if (client.type === 'oauth') {
      const sections = ['inbox', 'social', 'promotions'];
      const labelMap = {
        inbox:      ['INBOX'],
        social:     ['INBOX', 'CATEGORY_SOCIAL'],
        promotions: ['INBOX', 'CATEGORY_PROMOTIONS']
      };
      const results = {};
      await Promise.all(sections.map(async tab => {
        const [all, unread] = await Promise.all([
          client.gmail.users.messages.list({ userId: 'me', labelIds: labelMap[tab], maxResults: 1 }),
          client.gmail.users.messages.list({ userId: 'me', labelIds: [...labelMap[tab], 'UNREAD'], maxResults: 1 })
        ]);
        const total    = all.data.resultSizeEstimate    || 0;
        const unreadN  = unread.data.resultSizeEstimate || 0;
        results[tab] = { total, unread: unreadN, read: Math.max(0, total - unreadN) };
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
  if (!client || client.type !== 'oauth') return res.status(400).json({ error: 'OAuth required for trash clear' });

  try {
    const list = await client.gmail.users.messages.list({ userId: 'me', labelIds: ['TRASH'], maxResults: 500 });
    const msgs = list.data.messages || [];
    if (!msgs.length) return res.json({ success: true, cleared: 0 });
    const ids = msgs.map(m => m.id);
    await client.gmail.users.messages.batchDelete({ userId: 'me', requestBody: { ids } });
    const email = req.session.googleUser?.email;
    addLog(email, `🗑️ Cleared trash: ${ids.length} emails deleted`);
    res.json({ success: true, cleared: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SEND EMAIL ──
app.post('/api/gmail/send', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'Missing fields' });
  const email = req.session.googleUser?.email || req.session.gmailUser;
  try {
    const client = getGmailClient(req);
    if (client?.type === 'oauth') {
      const raw = Buffer.from(
        [`From:${email}`, `To:${to}`, `Subject:${subject}`, 'MIME-Version:1.0', 'Content-Type:text/plain;charset=utf-8', '', body].join('\r\n')
      ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await client.gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    } else {
      const t = getTransporter(req.session.gmailUser, req.session.gmailPassword);
      await Promise.race([
        t.sendMail({ from: email, to, subject, text: body }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Send timeout')), 15000))
      ]);
    }
    const u = users.find(u => u.email === email);
    if (u) { u.emailsSent = (u.emailsSent || 0) + 1; saveUsers(); }
    addLog(email, `✅ Sent email to: ${to} — ${subject}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── IMAP FETCH HELPER ──
function fetchIMAP(user, pass, tab, limit) {
  return new Promise((resolve, reject) => {
    const folderMap = { inbox: 'INBOX', social: '[Gmail]/Social', promotions: '[Gmail]/Promotions' };
    const folder = folderMap[tab] || 'INBOX';
    const imap = new Imap({ user, password: pass, host: 'imap.gmail.com', port: 993, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 20000, authTimeout: 15000 });
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
  const f = imap.seq.fetch(`${start}:${total}`, { bodies: ['HEADER', 'TEXT'], markSeen: false });
  const msgs = [];
  f.on('message', (msg, seqno) => {
    const m = { seqno, header: '', body: '', attrs: {} };
    msg.on('body', (stream, info) => {
      let buf = '';
      stream.on('data', d => buf += d.toString('utf8'));
      stream.once('end', () => { if (info.which === 'HEADER') m.header = buf; else m.body += buf; });
    });
    msg.once('attributes', a => m.attrs = a);
    msg.once('end', () => msgs.push(m));
  });
  f.once('error', err => { imap.end(); reject(err); });
  f.once('end', () => {
    imap.end();
    Promise.all(msgs.map(async m => {
      try {
        const parsed = await simpleParser(m.header + '\r\n\r\n' + m.body.slice(0, 3000));
        const flags  = m.attrs.flags || [];
        const isRead = flags.some(f => f === '\\Seen' || f.toLowerCase() === '\\seen');
        const body   = (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        return { id: String(m.attrs.uid || m.seqno), from: parsed.from?.text || 'Unknown', subject: parsed.subject || '(No Subject)', date: parsed.date ? new Date(parsed.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '', body, snippet: body.slice(0, 100), read: isRead };
      } catch { return null; }
    })).then(r => resolve(r.filter(Boolean).reverse())).catch(reject);
  });
}

// ── AI SUGGESTIONS ENDPOINT ──
app.post('/api/ai/suggest', async (req, res) => {
  const { emailContent, sender, subject } = req.body;
  const suggestions = await getAISuggestions(emailContent, sender, subject);
  res.json({ suggestions });
});

// ── AI BOT CHAT ──
app.post('/api/ai/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });
  if (!config.ANTHROPIC_API_KEY) return res.json({ reply: 'AI features require an Anthropic API key in your .env file.' });

  try {
    const messages = [
      ...(history || []).slice(-10),
      { role: 'user', content: message }
    ];
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-5-20251001',
      max_tokens: 500,
      system: 'You are a helpful assistant inside VoiceMailAssist, a voice-first email and messaging app. Keep answers short and clear — they will be spoken aloud.',
      messages
    }, {
      headers: {
        'x-api-key': config.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });
    res.json({ reply: r.data.content[0].text.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
//  TELEGRAM MTProto (GramJS) — Real Personal Chats
// ════════════════════════════════════════
const tgClients = {};
const tgCodeCallbacks = {};

app.post('/api/telegram/mtproto/start', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const sessionKey = phone.replace(/\D/g, '');
  const savedSession = tgSessions[sessionKey] || '';

  try {
    const client = new TelegramClient(
      new StringSession(savedSession),
      config.TELEGRAM_API_ID,
      config.TELEGRAM_API_HASH,
      { connectionRetries: 3 }
    );

    await client.connect();

    if (await client.isUserAuthorized()) {
      tgClients[sessionKey] = client;
      req.session.tgPhone   = phone;
      req.session.tgSession = sessionKey;
      addLog(req.session.googleUser?.email || 'user', `Telegram MTProto connected: ${phone}`);
      return res.json({ success: true, needCode: false });
    }

    await client.sendCode({ apiId: config.TELEGRAM_API_ID, apiHash: config.TELEGRAM_API_HASH }, phone);

    tgClients[sessionKey]      = client;
    tgCodeCallbacks[sessionKey] = null;
    req.session.tgPhone        = phone;
    req.session.tgSession      = sessionKey;

    res.json({ success: true, needCode: true });
  } catch (err) {
    console.error('TG MTProto start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/telegram/mtproto/verify', async (req, res) => {
  const { code, phone, password } = req.body;
  const sessionKey = (phone || req.session.tgPhone || '').replace(/\D/g, '');
  const client     = tgClients[sessionKey];
  if (!client) return res.status(400).json({ error: 'No active session. Please start again.' });

  try {
    await client.signIn(
      { apiId: config.TELEGRAM_API_ID, apiHash: config.TELEGRAM_API_HASH },
      { phoneNumber: phone || req.session.tgPhone, phoneCode: async () => code, password: async () => password || '' }
    );

    const session = client.session.save();
    tgSessions[sessionKey] = session;
    saveTgSessions();
    req.session.tgSession = sessionKey;
    addLog(req.session.googleUser?.email || 'user', `Telegram verified: ${phone}`);
    res.json({ success: true });
  } catch (err) {
    console.error('TG verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/telegram/mtproto/chats', async (req, res) => {
  const sessionKey = req.session.tgSession;
  const client     = tgClients[sessionKey];
  if (!client) return res.status(401).json({ error: 'Not connected to Telegram' });

  try {
    const dialogs = await client.getDialogs({ limit: 30 });
    const chats   = dialogs.map(d => ({
      id:       String(d.id),
      name:     d.title || d.name || 'Unknown',
      unread:   d.unreadCount || 0,
      lastMsg:  d.message?.message || '',
      lastDate: d.message?.date ? new Date(d.message.date * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    }));
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/telegram/mtproto/messages', async (req, res) => {
  const sessionKey = req.session.tgSession;
  const client     = tgClients[sessionKey];
  const { chatId } = req.query;
  if (!client) return res.status(401).json({ error: 'Not connected' });

  try {
    const messages = await client.getMessages(chatId, { limit: 30 });
    const me       = await client.getMe();
    const formatted = messages.reverse().map(m => ({
      id:     m.id,
      text:   m.message || '',
      fromMe: String(m.fromId?.userId) === String(me.id),
      date:   m.date ? new Date(m.date * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    }));
    res.json({ messages: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/telegram/mtproto/send', async (req, res) => {
  const sessionKey = req.session.tgSession;
  const client     = tgClients[sessionKey];
  const { chatId, message } = req.body;
  if (!client) return res.status(401).json({ error: 'Not connected' });

  try {
    await client.sendMessage(chatId, { message });
    addLog(req.session.googleUser?.email || 'user', `✅ TG MTProto sent to: ${chatId}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bot API fallback for sending
const tgBase = () => `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;

app.get('/api/telegram/chats', async (_, res) => {
  if (!config.TELEGRAM_BOT_TOKEN) return res.json({ chats: [] });
  try {
    const r = await axios.get(`${tgBase()}/getUpdates?limit=100`);
    const map = {};
    (r.data.result || []).forEach(u => {
      if (!u.message) return;
      const c = u.message.chat, k = String(c.id);
      if (!map[k]) map[k] = { id: c.id, name: c.first_name ? `${c.first_name} ${c.last_name || ''}`.trim() : c.title || 'Unknown', messages: [] };
      map[k].messages.push({ text: u.message.text || '[Media]', fromMe: false, date: new Date(u.message.date * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    });
    res.json({ chats: Object.values(map) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/telegram/send', async (req, res) => {
  const { chatId, message } = req.body;
  try {
    await axios.post(`${tgBase()}/sendMessage`, { chat_id: chatId || config.TELEGRAM_CHAT_ID, text: message });
    addLog('user', '✅ Telegram bot message sent');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN ROUTES ──
function requireAdmin(req, res, next) {
  if (req.session.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

app.post('/api/admin/log', (req, res) => {
  const { user, action } = req.body;
  if (action) addLog(user || req.session.gmailUser || 'browser', action);
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, (_, res) => {
  const c = kw => actLog.filter(e => e.action.toLowerCase().includes(kw)).length;
  res.json({ totalUsers: users.length, emailsSent: c('sent email'), tgMessages: c('telegram'), pinSuccess: c('pin verified'), pinFailed: c('pin failed') + c('blocked'), totalLogins: c('logged in'), totalActivities: actLog.length });
});

app.get('/api/admin/logs',     requireAdmin, (_, res) => res.json({ logs: actLog.slice(0, 50), total: actLog.length }));
app.get('/api/admin/users',    requireAdmin, (_, res) => res.json({ users: users.map(u => ({ ...u, pin: u.pin ? '••••' : null })) }));
app.get('/api/admin/analytics', requireAdmin, (_, res) => {
  const byUser = {};
  actLog.forEach(e => {
    if (!byUser[e.user]) byUser[e.user] = { logins: 0, emailsSent: 0, tgSent: 0, pinOk: 0, pinFail: 0 };
    const a = e.action.toLowerCase();
    if (a.includes('logged in'))    byUser[e.user].logins++;
    if (a.includes('sent email'))   byUser[e.user].emailsSent++;
    if (a.includes('telegram'))     byUser[e.user].tgSent++;
    if (a.includes('pin verified')) byUser[e.user].pinOk++;
    if (a.includes('pin failed') || a.includes('blocked')) byUser[e.user].pinFail++;
  });
  res.json({ byUser, total: actLog.length, users: users.length });
});
app.get('/api/admin/email-report', requireAdmin, (_, res) => {
  res.json({ report: users.map(u => ({ email: u.email, name: u.name, emailsSent: u.emailsSent || 0, lastLogin: u.lastLogin || 'Never', hasPin: !!u.pin })) });
});
app.get('/api/admin/export-logs', requireAdmin, (_, res) => res.json(actLog));
app.get('/api/admin/status', (_, res) => res.json({
  server: 'online', gmail: true,
  telegram: !!(config.TELEGRAM_BOT_TOKEN),
  uptime: process.uptime(), nodeVersion: process.version, timestamp: new Date().toISOString()
}));

app.delete('/api/admin/users/:email', requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email);
  users = users.filter(u => u.email !== email);
  saveUsers();
  addLog(req.session.gmailUser, `Admin removed user: ${email}`);
  res.json({ ok: true });
});

// ── START ──
const PORT = config.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`  ✅  VoiceMailAssist v5 — Running`);
  console.log(`  🌐  http://localhost:${PORT}/app.html`);
  console.log(`  🔐  Admin: ${ADMIN_EMAIL} + App Password`);
  console.log(`  👤  Users: Google OAuth`);
  console.log(`  ⏱️   Session timeout: 60 minutes`);
  console.log(`  💾  Auto backup: every 30 minutes`);
  console.log(`  🤖  AI: ${config.ANTHROPIC_API_KEY ? 'Connected' : 'No API key'}`);
  console.log(`  ✈️   Telegram MTProto: ${config.TELEGRAM_API_ID ? 'Ready' : 'No credentials'}`);
  console.log(`══════════════════════════════════════════════════════\n`);
});
