// ============================================================
//  VoiceMailAssist v4 — server.js (Final Complete Edition)
//  Features: OAuth users, IMAP admin, session timeout 60min,
//  load balancing, auto backup, PDF export, analytics
// ============================================================
const cluster    = require('cluster');
const os         = require('os');
const express    = require('express');
const session    = require('express-session');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const axios      = require('axios');
const nodemailer = require('nodemailer');
const Imap       = require('node-imap');
const { simpleParser } = require('mailparser');
const { google }  = require('googleapis');
const config      = require('./config');

// ── LOAD BALANCING via cluster ──
if (cluster.isMaster) {
  const cpus = Math.min(os.cpus().length, 2); // max 2 workers
  console.log(`\n🔄 Load Balancing: Starting ${cpus} workers`);
  for (let i = 0; i < cpus; i++) cluster.fork();
  cluster.on('exit', (worker) => {
    console.log(`⚠️  Worker ${worker.id} died — restarting`);
    cluster.fork();
  });
  return;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: config.SESSION_SECRET || 'vma-v4-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 3600000 } // 60 minutes
}));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

// ── SESSION TIMEOUT MIDDLEWARE (60 minutes) ──
app.use((req, res, next) => {
  if (req.session && req.session.loggedIn) {
    const now = Date.now();
    const last = req.session.lastActivity || now;
    if (now - last > 3600000) { // 60 min
      req.session.destroy();
      return res.status(401).json({ error: 'Session expired', sessionExpired: true });
    }
    req.session.lastActivity = now;
  }
  next();
});

// ── DATA FILES ──
const LOG_FILE     = path.join(__dirname, 'activity_log.json');
const USERS_FILE   = path.join(__dirname, 'users.json');
const BACKUP_DIR   = path.join(__dirname, 'backups');

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

let actLog = [];
let users  = []; // registered users with PIN

if (fs.existsSync(LOG_FILE))   { try { actLog = JSON.parse(fs.readFileSync(LOG_FILE,   'utf-8')); } catch {} }
if (fs.existsSync(USERS_FILE)) { try { users  = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')); } catch {} }

// ── AUTO BACKUP every 30 minutes ──
function doBackup() {
  try {
    const ts  = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(BACKUP_DIR, `activity_log_${ts}.json`);
    if (fs.existsSync(LOG_FILE)) fs.copyFileSync(LOG_FILE, dst);
    // Keep only last 10 backups
    const files = fs.readdirSync(BACKUP_DIR).sort().reverse();
    files.slice(10).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
    console.log(`💾 Backup done: ${dst}`);
  } catch (e) { console.error('Backup error:', e.message); }
}
setInterval(doBackup, 30 * 60 * 1000);

function addLog(user, action) {
  const e = { time: new Date().toLocaleTimeString(), date: new Date().toLocaleDateString(), timestamp: new Date().toISOString(), user: user || 'unknown', action };
  actLog.unshift(e);
  if (actLog.length > 200) actLog = actLog.slice(0, 200);
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(actLog, null, 2)); } catch {}
  console.log(`📋 [${e.time}] ${e.user}: ${action}`);
}

function saveUsers() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch {}
}

app.post('/api/admin/log', (req, res) => {
  const { user, action } = req.body;
  if (action) addLog(user || req.session.gmailUser || 'browser', action);
  res.json({ ok: true });
});

// ══════════════════════════════════════════
//  GOOGLE OAUTH — for regular users
// ══════════════════════════════════════════
function getOAuth(redirectUri) {
  return new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    redirectUri || config.GOOGLE_REDIRECT_URI
  );
}

// Start OAuth flow
app.get('/auth/google', (req, res) => {
  const type = req.query.type || 'login'; // login or signup
  req.session.oauthType = type;
  if (!config.GOOGLE_CLIENT_ID || config.GOOGLE_CLIENT_ID.startsWith('PASTE'))
    return res.send('<h2>Add Google credentials to config.js</h2>');
  const oauth = getOAuth();
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    scope: config.GOOGLE_SCOPES || [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
});

// OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/app.html?error=auth_failed');
  try {
    const oauth = getOAuth();
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);
    const { data: profile } = await google.oauth2({ version: 'v2', auth: oauth }).userinfo.get();
    const oauthType = req.session.oauthType || 'login';

    req.session.googleTokens  = tokens;
    req.session.googleUser    = { email: profile.email, name: profile.name };
    req.session.loggedIn      = true;
    req.session.userRole      = 'user';
    req.session.lastActivity  = Date.now();

    // Save/update user record
    let u = users.find(u => u.email === profile.email);
    if (!u) {
      u = { email: profile.email, name: profile.name, pin: null, createdAt: new Date().toISOString(), emailsSent: 0, lastLogin: null };
      users.push(u);
      saveUsers();
    }
    u.lastLogin = new Date().toISOString();
    saveUsers();

    addLog(profile.email, `User ${oauthType === 'signup' ? 'signed up' : 'logged in'} via Google OAuth`);

    if (oauthType === 'signup') {
      // New user needs to set PIN
      return res.redirect('/app.html?step=setpin');
    } else {
      // Check if user has PIN set
      if (!u.pin) return res.redirect('/app.html?step=setpin');
      return res.redirect('/app.html?step=lang');
    }
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/app.html?error=auth_failed');
  }
});

// Save user PIN
app.post('/api/user/setpin', (req, res) => {
  if (!req.session.googleUser) return res.status(401).json({ error: 'Not logged in' });
  const { pin } = req.body;
  if (!pin || pin.length !== 4) return res.status(400).json({ error: 'PIN must be 4 digits' });
  const u = users.find(u => u.email === req.session.googleUser.email);
  if (u) { u.pin = pin; saveUsers(); }
  req.session.userPIN = pin;
  addLog(req.session.googleUser.email, 'User set security PIN');
  res.json({ success: true });
});

// Get user PIN (for verification)
app.get('/api/user/pin', (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const email = req.session.googleUser?.email || req.session.gmailUser;
  const u = users.find(u => u.email === email);
  // Return pin for client-side verification
  res.json({ pin: u?.pin || req.session.userPIN || '0413' });
});

// Auth status
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

// ══════════════════════════════════════════
//  ADMIN LOGIN — IMAP (only shruthir0413@gmail.com)
// ══════════════════════════════════════════
const ADMIN_EMAIL = 'shruthir0413@gmail.com';

function verifyIMAP(user, pass) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({ user, password: pass, host: 'imap.gmail.com', port: 993, tls: true, tlsOptions: { rejectUnauthorized: false }, connTimeout: 15000, authTimeout: 10000 });
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

  // Only admin email allowed
  if (email !== ADMIN_EMAIL) {
    addLog(email, '❌ Admin login rejected — unauthorized email');
    return res.status(403).json({ success: false, error: 'Access denied. This login is for admin only.' });
  }

  console.log(`🔐 Admin IMAP login: ${email}`);
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
    let msg = 'Login failed. ';
    if (err.message.toLowerCase().includes('auth') || err.message.toLowerCase().includes('invalid')) {
      msg += 'Wrong App Password. Get from myaccount.google.com/apppasswords';
    } else msg += err.message;
    res.status(401).json({ success: false, error: msg });
  }
});

// ══════════════════════════════════════════
//  GMAIL — fetch emails (works for both admin IMAP and user OAuth)
// ══════════════════════════════════════════
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

function decB64(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'); }
function getBody(payload) {
  let t = '';
  function w(p) { if (!p) return; if (p.mimeType === 'text/plain' && p.body?.data) t += decB64(p.body.data); if (p.parts) p.parts.forEach(w); }
  w(payload); return t.slice(0, 1500);
}
function hdr(headers, name) { return (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || ''; }

// Summarize email using AI (2-3 sentences)
async function summarizeEmail(body, subject, sender) {
  if (!config.ANTHROPIC_API_KEY || config.ANTHROPIC_API_KEY.startsWith('PASTE')) {
    // Simple fallback summary
    const text = (body || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 200) + (text.length > 200 ? '...' : '');
  }
  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514', max_tokens: 150,
      messages: [{ role: 'user', content: `Summarize this email in 2-3 short sentences for voice reading. Use natural pauses with commas. Keep it conversational.\nFrom: ${sender}\nSubject: ${subject}\nBody: ${(body || '').slice(0, 500)}\nReturn ONLY the summary, nothing else.` }]
    }, { headers: { 'x-api-key': config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    return r.data.content[0].text.trim();
  } catch { return (body || '').replace(/\s+/g, ' ').trim().slice(0, 200); }
}

app.get('/api/gmail/emails', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in', emails: [] });
  const tab    = req.query.tab || 'inbox';
  const limit  = parseInt(req.query.maxResults) || 5;
  const client = getGmailClient(req);
  if (!client) return res.status(401).json({ error: 'No Gmail connection', emails: [] });

  try {
    if (client.type === 'oauth') {
      // OAuth path for users
      const labels = { inbox: ['INBOX'], social: ['INBOX', 'CATEGORY_SOCIAL'], promotions: ['INBOX', 'CATEGORY_PROMOTIONS'] };
      const list = await client.gmail.users.messages.list({ userId: 'me', maxResults: limit, labelIds: labels[tab] || ['INBOX'] });
      const msgs = list.data.messages || [];
      if (!msgs.length) return res.json({ emails: [] });
      const emails = await Promise.all(msgs.map(async ({ id }) => {
        const msg = await client.gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const hdrs = msg.data.payload.headers;
        const bodyText = getBody(msg.data.payload);
        const fromText = hdr(hdrs, 'From');
        const subj     = hdr(hdrs, 'Subject');
        const summary  = await summarizeEmail(bodyText, subj, fromText);
        return {
          id, from: fromText, subject: subj,
          date: hdr(hdrs, 'Date') ? new Date(hdr(hdrs, 'Date')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
          body: bodyText, summary, snippet: msg.data.snippet,
          read: !(msg.data.labelIds || []).includes('UNREAD')
        };
      }));
      addLog(req.session.googleUser?.email, `Fetched ${emails.length} emails (${tab})`);
      return res.json({ emails });
    } else {
      // IMAP path for admin
      const emails = await fetchIMAP(client.user, client.pass, tab, limit);
      // Add summaries
      const withSummary = await Promise.all(emails.map(async e => ({ ...e, summary: await summarizeEmail(e.body, e.subject, e.from) })));
      addLog(client.user, `Fetched ${withSummary.length} emails (${tab})`);
      return res.json({ emails: withSummary });
    }
  } catch (err) {
    console.error('Fetch emails error:', err.message);
    res.status(500).json({ error: err.message, emails: [] });
  }
});

// IMAP fetch helper
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

app.get('/api/gmail/count', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  try {
    const client = getGmailClient(req);
    if (client?.type === 'oauth') {
      const [all, unread] = await Promise.all([
        client.gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], maxResults: 1 }),
        client.gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX', 'UNREAD'], maxResults: 1 })
      ]);
      const total = all.data.resultSizeEstimate || 0, unreadN = unread.data.resultSizeEstimate || 0;
      res.json({ total, unread: unreadN, read: total - unreadN });
    } else {
      const all = await fetchIMAP(req.session.gmailUser, req.session.gmailPassword, 'inbox', 50);
      const u = all.filter(e => !e.read).length;
      res.json({ total: all.length, unread: u, read: all.length - u });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gmail/send', async (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'Missing fields' });
  const email = req.session.googleUser?.email || req.session.gmailUser;
  try {
    const client = getGmailClient(req);
    if (client?.type === 'oauth') {
      const raw = Buffer.from([`From:${email}`, `To:${to}`, `Subject:${subject}`, 'MIME-Version:1.0', 'Content-Type:text/plain;charset=utf-8', '', body].join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      await client.gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    } else {
      const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user: req.session.gmailUser, pass: req.session.gmailPassword }, tls: { rejectUnauthorized: false } });
      await t.sendMail({ from: email, to, subject, text: body });
    }
    // Update user email count
    const u = users.find(u => u.email === email);
    if (u) { u.emailsSent = (u.emailsSent || 0) + 1; saveUsers(); }
    addLog(email, `✅ Sent email to: ${to} — ${subject}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════
const tgBase = () => `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
app.get('/api/telegram/chats', async (_, res) => {
  if (!config.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN.startsWith('PASTE')) return res.json({ chats: [] });
  try {
    const r = await axios.get(`${tgBase()}/getUpdates?limit=100`);
    const map = {};
    (r.data.result || []).forEach(u => {
      if (!u.message) return;
      const c = u.message.chat, k = String(c.id);
      if (!map[k]) map[k] = { id: c.id, name: c.first_name ? `${c.first_name} ${c.last_name || ''}`.trim() : c.title || 'Unknown', messages: [] };
      map[k].messages.push({ text: u.message.text || '[Media]', fromMe: String(u.message.from?.id) === String(config.TELEGRAM_CHAT_ID), date: new Date(u.message.date * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    });
    res.json({ chats: Object.values(map) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/telegram/send', async (req, res) => {
  if (!config.TELEGRAM_BOT_TOKEN || config.TELEGRAM_BOT_TOKEN.startsWith('PASTE')) return res.status(400).json({ error: 'Set token' });
  const { chatId, message } = req.body;
  try {
    await axios.post(`${tgBase()}/sendMessage`, { chat_id: chatId || config.TELEGRAM_CHAT_ID, text: message });
    const email = req.session.googleUser?.email || req.session.gmailUser;
    addLog(email || 'user', `✅ Sent Telegram to: ${chatId}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════
//  AI SUGGESTIONS
// ══════════════════════════════════════════
app.post('/api/ai/suggest', async (req, res) => {
  const { emailContent, sender, subject } = req.body;
  if (!config.ANTHROPIC_API_KEY || config.ANTHROPIC_API_KEY.startsWith('PASTE')) return res.json({ suggestions: fb(emailContent, subject) });
  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514', max_tokens: 300,
      messages: [{ role: 'user', content: `Generate exactly 3 short professional reply suggestions (1 sentence each).\nFrom: ${sender} | Subject: ${subject}\nEmail: ${(emailContent || '').slice(0, 400)}\nReturn ONLY a JSON array: ["reply1","reply2","reply3"]` }]
    }, { headers: { 'x-api-key': config.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    res.json({ suggestions: JSON.parse(r.data.content[0].text.replace(/```json|```/g, '').trim()) });
  } catch { res.json({ suggestions: fb(emailContent, subject) }); }
});

function fb(body, subject) {
  const b = (body || subject || '').toLowerCase();
  if (b.includes('security') || b.includes('alert'))  return ['The sign-in was mine.', 'I did not do this.', 'Thank you for the alert.'];
  if (b.includes('bill')     || b.includes('invoice')) return ['Thank you, will review.', 'Invoice received.', 'Will process soon.'];
  if (b.includes('meeting'))                           return ['Confirmed, I will be there.', 'Thanks for reminder!', 'Please share the link.'];
  return ['Thank you, will respond.', 'Got it, noted.', 'Will follow up soon.'];
}

// ══════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════
function requireAdmin(req, res, next) {
  if (req.session.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

app.get('/api/admin/stats', requireAdmin, (_, res) => {
  const c = kw => actLog.filter(e => e.action.toLowerCase().includes(kw)).length;
  res.json({ totalUsers: users.length, emailsSent: c('sent email'), tgMessages: c('telegram'), pinSuccess: c('pin verified'), pinFailed: c('pin failed') + c('blocked'), totalLogins: c('logged in') + c('oauth'), totalActivities: actLog.length });
});

app.get('/api/admin/logs',     requireAdmin, (_, res) => res.json({ logs: actLog.slice(0, 50), total: actLog.length }));
app.delete('/api/admin/logs',  requireAdmin, (_, res) => { actLog = []; try { fs.writeFileSync(LOG_FILE, '[]'); } catch {} res.json({ ok: true }); });

// User management
app.get('/api/admin/users',    requireAdmin, (_, res) => res.json({ users }));
app.delete('/api/admin/users/:email', requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email);
  users = users.filter(u => u.email !== email);
  saveUsers();
  addLog(req.session.gmailUser, `Admin removed user: ${email}`);
  res.json({ ok: true });
});

// Usage analytics
app.get('/api/admin/analytics', requireAdmin, (_, res) => {
  const byUser = {};
  actLog.forEach(e => {
    if (!byUser[e.user]) byUser[e.user] = { logins: 0, emailsSent: 0, tgSent: 0, pinOk: 0, pinFail: 0 };
    const a = e.action.toLowerCase();
    if (a.includes('logged in') || a.includes('oauth')) byUser[e.user].logins++;
    if (a.includes('sent email'))   byUser[e.user].emailsSent++;
    if (a.includes('telegram'))     byUser[e.user].tgSent++;
    if (a.includes('pin verified')) byUser[e.user].pinOk++;
    if (a.includes('pin failed') || a.includes('blocked')) byUser[e.user].pinFail++;
  });
  res.json({ byUser, total: actLog.length, users: users.length });
});

// Email usage reports per user
app.get('/api/admin/email-report', requireAdmin, (_, res) => {
  const report = users.map(u => ({
    email: u.email, name: u.name,
    emailsSent: u.emailsSent || 0,
    lastLogin: u.lastLogin || 'Never',
    createdAt: u.createdAt || 'Unknown',
    hasPin: !!u.pin
  }));
  res.json({ report });
});

// Export logs as JSON (for PDF generation on frontend)
app.get('/api/admin/export-logs', requireAdmin, (_, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=activity_log.json');
  res.json(actLog);
});

// Backups list
app.get('/api/admin/backups', requireAdmin, (_, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR).sort().reverse().slice(0, 10);
    res.json({ backups: files });
  } catch { res.json({ backups: [] }); }
});

app.get('/api/admin/status', (_, res) => res.json({
  server: 'online', gmail: true,
  telegram: !!(config.TELEGRAM_BOT_TOKEN && !config.TELEGRAM_BOT_TOKEN.startsWith('PASTE')),
  uptime: process.uptime(), nodeVersion: process.version, timestamp: new Date().toISOString(),
  worker: cluster.worker?.id || 1
}));

// ══════════════════════════════════════════
//  START
// ══════════════════════════════════════════
const PORT = config.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`  ✅  VoiceMailAssist v4 — Worker ${cluster.worker?.id || 1}`);
  console.log(`  🌐  http://localhost:${PORT}/app.html`);
  console.log(`  🔐  Admin: ${ADMIN_EMAIL} + App Password`);
  console.log(`  👤  Users: Google OAuth`);
  console.log(`  ⏱️   Session timeout: 60 minutes`);
  console.log(`  💾  Auto backup: every 30 minutes`);
  console.log(`══════════════════════════════════════════════════════\n`);
});
