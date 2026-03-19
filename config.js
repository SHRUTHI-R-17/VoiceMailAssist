module.exports = {
  PORT:               process.env.PORT               || 3000,
  SESSION_SECRET:     process.env.SESSION_SECRET     || 'VoiceMailAssist2024XyZ987!',
  GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID     || '378056942601-v61vts5d4ttq1enk92nifcbi01q51gtk.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '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',
  GOOGLE_REDIRECT_URI:  process.env.GOOGLE_REDIRECT_URI  || 'http://localhost:3000/auth/google/callback',
  GOOGLE_SCOPES: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'profile',
    'email'
  ],
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8761626982:AAGNY_UwC4kqtpslwAPUqVX2PZ_gndYi7-g',
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   || '7783833264',
  ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY  || ''
};