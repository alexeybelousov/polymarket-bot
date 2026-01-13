const { Telegraf } = require('telegraf');
const config = require('../config');
const handlers = require('./handlers');

function createBot() {
  const bot = new Telegraf(config.telegram.token);

  bot.start(handlers.handleStart);

  bot.action('signals', handlers.handleSignals);
  bot.action('toggle_eth_3', handlers.handleToggleEth3);
  bot.action('toggle_eth_2', handlers.handleToggleEth2);
  bot.action('toggle_btc_3', handlers.handleToggleBtc3);
  bot.action('toggle_btc_2', handlers.handleToggleBtc2);
  bot.action('trading', handlers.handleTrading);
  bot.action('toggle_trading', handlers.handleToggleTrading);
  bot.action('back_to_main', handlers.handleBackToMain);

  bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
  });

  return bot;
}

module.exports = { createBot };
