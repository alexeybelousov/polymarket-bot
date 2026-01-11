const { Telegraf } = require('telegraf');
const config = require('../config');
const handlers = require('./handlers');

function createBot() {
  const bot = new Telegraf(config.telegram.token);

  // Команды
  bot.start(handlers.handleStart);

  // Callback queries (кнопки)
  bot.action('signals', handlers.handleSignals);
  bot.action('toggle_eth', handlers.handleToggleEth);
  bot.action('toggle_btc', handlers.handleToggleBtc);
  bot.action('back_to_main', handlers.handleBackToMain);

  // Обработка ошибок
  bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
  });

  return bot;
}

module.exports = { createBot };

