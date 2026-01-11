// TODO: Раскомментировать когда MongoDB будет готова
// const mongoose = require('mongoose');

const config = require('./config');
const { createBot } = require('./bot');
const SignalTracker = require('./services/signalTracker');

async function main() {
  console.log('🤖 Starting Polymarket Bot...');

  // Проверяем наличие токена
  if (!config.telegram.token) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set!');
    process.exit(1);
  }

  // TODO: Раскомментировать когда MongoDB будет готова
  // // Подключаемся к MongoDB
  // try {
  //   await mongoose.connect(config.mongodb.uri);
  //   console.log('✅ Connected to MongoDB');
  // } catch (error) {
  //   console.error('❌ MongoDB connection error:', error.message);
  //   process.exit(1);
  // }

  console.log('✅ Using JSON file storage (data/users.json)');

  // Создаём и запускаем бота
  const bot = createBot();
  
  // Создаём и запускаем трекер сигналов
  const signalTracker = new SignalTracker(bot);
  signalTracker.start();

  // Запускаем бота
  bot.launch();
  console.log('✅ Bot is running!');

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n${signal} received. Shutting down...`);
    signalTracker.stop();
    bot.stop(signal);
    // TODO: Раскомментировать когда MongoDB будет готова
    // await mongoose.connection.close();
    console.log('👋 Bye!');
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(console.error);
