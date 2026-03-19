// ============================================================
//  VoiceMailAssist v4 — config.example.js
//  Copy this file to config.js and fill in your values
//  NEVER commit config.js to GitHub
// ============================================================
module.exports = {
  GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID     || 'YOUR_GOOGLE_CLIENT_ID',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || 'YOUR_GOOGLE_CLIENT_SECRET',
  GOOGLE_REDIRECT_URI:  process.env.GOOGLE_REDIRECT_URI  || 'http://localhost:3000/auth/google/callback',
  GOOGLE_SCOPES: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ],
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN',
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   || 'YOUR_TELEGRAM_CHAT_ID',
  ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY  || 'YOUR_ANTHROPIC_API_KEY',
  SESSION_SECRET:     process.env.SESSION_SECRET      || 'YOUR_RANDOM_SECRET_STRING',
  PORT:               process.env.PORT                || 3000
};
