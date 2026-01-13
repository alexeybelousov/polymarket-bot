const mongoose = require('mongoose');

const config = require('./config');
const { createBot } = require('./bot');
const SignalDetector = require('./services/signalDetector');
const SignalNotifier = require('./services/signalNotifier');
const TradingEmulator = require('./services/tradingEmulator');
const { createServer } = require('./server');
const polymarket = require('./services/polymarket');
const binance = require('./services/binance');

// Выбираем источник данных
const dataProvider = config.dataSource === 'binance' ? binance : polymarket;

async function main() {
  console.log('🤖 Starting Polymarket Bot...');

  if (!config.telegram.token) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set!');
    process.exit(1);
  }

  // Подключаемся к MongoDB
  try {
    await mongoose.connect(config.mongodb.uri);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }

  // Создаём бота
  const bot = createBot();
  
  // Эмулятор торговли
  const tradingEmulator = new TradingEmulator(bot, dataProvider);
  await tradingEmulator.start();

  // Детектор сигналов (определяет и сохраняет в БД)
  const signalDetector = new SignalDetector(tradingEmulator);
  signalDetector.start();

  // Нотификатор (читает из БД и отправляет в TG)
  const signalNotifier = new SignalNotifier(bot);
  signalNotifier.start();

  // HTTP сервер с дашбордом
  const server = createServer(config.server?.port || 3000, tradingEmulator);

  // Запускаем бота
  bot.launch({ dropPendingUpdates: true });
  console.log('✅ Bot is running!');

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down...`);
    signalDetector.stop();
    signalNotifier.stop();
    tradingEmulator.stop();
    bot.stop(signal);
    server.close();
    await mongoose.connection.close();
    console.log('👋 Bye!');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(console.error);
