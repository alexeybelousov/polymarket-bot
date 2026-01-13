require('dotenv').config();

module.exports = {
  debug: process.env.DEBUG === 'true',
  // Источник данных: 'polymarket' или 'binance'
  dataSource: process.env.DATA_SOURCE || 'binance',
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
  },
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/polymarket-bot',
  },
  polymarket: {
    checkInterval: parseInt(process.env.POLYMARKET_CHECK_INTERVAL) || 5000,
    gammaApiUrl: 'https://gamma-api.polymarket.com',
    clobApiUrl: 'https://clob.polymarket.com',
    markets: {
      eth: 'eth-updown-15m',
      btc: 'btc-updown-15m',
    },
    minTimeBeforeEnd: 60,
    colorHoldTime: 5,
  },
  server: {
    port: parseInt(process.env.SERVER_PORT) || 3000,
  },
};
