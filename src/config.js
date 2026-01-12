require('dotenv').config();

module.exports = {
  debug: process.env.DEBUG === 'true',
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
  },
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/polymarket-bot',
  },
  polymarket: {
    checkInterval: parseInt(process.env.POLYMARKET_CHECK_INTERVAL) || 5000, // 5 секунд
    gammaApiUrl: 'https://gamma-api.polymarket.com',
    markets: {
      eth: 'eth-updown-15m',
      btc: 'btc-updown-15m',
    },
    // Минимальное время до конца рынка для отправки сигнала (в секундах)
    minTimeBeforeEnd: 60,
    // Время удержания цвета на текущей свече (в секундах)
    colorHoldTime: 5, // 5 секунд
  },
};

