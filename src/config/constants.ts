export const RSS_FEED_URLS = process.env.RSS_FEED_URLS
  ? process.env.RSS_FEED_URLS.split(',').map(url => url.trim())
  : [
      "https://rss.app/feeds/w4Ru4NAR9U7AN4DZ.xml",
      "https://rss.app/feeds/lp93S41J4onjcEC8.xml",
      "https://rss.app/feeds/KcrfO8VmpGzIV7hV.xml",
      "https://rss.app/feeds/740W3eyo4bnyhwTs.xml"
    ];

export const CHECK_INTERVAL_MINUTES = parseInt(
  process.env.CHECK_INTERVAL_MINUTES || "60",
  10
);

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const CRON_SECRET = process.env.CRON_SECRET;

// GOAT channel — receives only top-tier Corporate/Quant/PE/IB/Data jobs at Entry/Mid level
export const GOAT_TELEGRAM_BOT_TOKEN = process.env.GOAT_TELEGRAM_BOT_TOKEN;
export const GOAT_TELEGRAM_CHAT_ID = process.env.GOAT_TELEGRAM_CHAT_ID;

// Aryan pipeline — separate feeds + bots, same filtering as main
export const RSS_ARYAN_FEED_URLS = process.env.RSS_ARYAN_FEED_URLS
  ? process.env.RSS_ARYAN_FEED_URLS.split(',').map(url => url.trim()).filter(Boolean)
  : [];

export const ARYAN_TELEGRAM_BOT_TOKEN = process.env.ARYAN_TELEGRAM_BOT_TOKEN;
export const ARYAN_TELEGRAM_CHAT_ID = process.env.ARYAN_TELEGRAM_CHAT_ID;

export const GOAT_ARYAN_TELEGRAM_BOT_TOKEN = process.env.GOAT_ARYAN_TELEGRAM_BOT_TOKEN;
export const GOAT_ARYAN_TELEGRAM_CHAT_ID = process.env.GOAT_ARYAN_TELEGRAM_CHAT_ID;

export const RATE_LIMIT_DELAY_MS = 2000; // Delay between Telegram messages

// Tracking configuration
export const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
export const TRACKING_SECRET = process.env.TRACKING_SECRET || 'default-dev-secret-change-in-production';
