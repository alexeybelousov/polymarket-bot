const mongoose = require('mongoose');

const config = require('./config');
const { createBot } = require('./bot');
const SignalDetector = require('./services/signalDetector');
const SignalNotifier = require('./services/signalNotifier');
const TradingEmulator = require('./services/tradingEmulator');
const { TRADING_CONFIGS } = require('./services/tradingEmulator');
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
  
  // Создаём несколько экземпляров эмулятора торговли (по одному на каждый конфиг)
  const tradingEmulators = [];
  console.log(`📋 Found ${Object.keys(TRADING_CONFIGS).length} bot configs: ${Object.keys(TRADING_CONFIGS).join(', ')}`);
  for (const [botId, config] of Object.entries(TRADING_CONFIGS)) {
    try {
      console.log(`🔄 Creating trading emulator: ${botId}...`);
      const emulator = new TradingEmulator(bot, dataProvider, botId, config);
      await emulator.start();
      tradingEmulators.push(emulator);
      console.log(`✅ Created trading emulator: ${botId}`);
    } catch (error) {
      console.error(`❌ Failed to create trading emulator ${botId}:`, error);
      throw error;
    }
  }

  // Детектор сигналов (определяет и сохраняет в БД, передает сигналы всем ботам)
  const signalDetector = new SignalDetector(tradingEmulators);
  signalDetector.start();

  // Нотификатор (читает из БД и отправляет в TG)
  const signalNotifier = new SignalNotifier(bot);
  signalNotifier.start();

  // HTTP сервер с дашбордом
  const server = createServer(config.server?.port || 3000, tradingEmulators);

  // Запускаем бота
  bot.launch({ dropPendingUpdates: true });
  console.log('✅ Bot is running!');

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down...`);
    signalDetector.stop();
    signalNotifier.stop();
    for (const emulator of tradingEmulators) {
      emulator.stop();
    }
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
