const User = require('../models/User');
const TradingStats = require('../models/TradingStats');
const keyboards = require('./keyboards');

const lastStartTime = new Map();
const START_DEBOUNCE_MS = 2000;

async function safeEditMessage(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (error) {
    if (!error.message?.includes('message is not modified')) {
      throw error;
    }
  }
}

async function getOrCreateUser(ctx) {
  let user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) {
    user = new User({
      telegramId: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
    });
    await user.save();
  }
  return user;
}

const SIGNALS_MESSAGE = 
  `📊 *Настройки сигналов*\n\n` +
  `• *3с* — сигнал когда 3 свечи одного цвета\n` +
  `• *2с* — сигнал когда 2 свечи одного цвета\n\n` +
  `Нажми на кнопку чтобы вкл/выкл:`;

async function handleStart(ctx) {
  const userId = ctx.from.id;
  const now = Date.now();
  
  const lastTime = lastStartTime.get(userId) || 0;
  if (now - lastTime < START_DEBOUNCE_MS) return;
  lastStartTime.set(userId, now);
  
  const user = await getOrCreateUser(ctx);
  
  const msg = 
    `👋 Привет, ${user.firstName || 'трейдер'}!\n\n` +
    `Бот для сигналов Polymarket.\n\n` +
    `Выбери действие:`;

  await ctx.reply(msg, keyboards.mainMenu());
}

async function handleSignals(ctx) {
  const user = await getOrCreateUser(ctx);
  
  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, SIGNALS_MESSAGE, {
      parse_mode: 'Markdown',
      ...keyboards.signalsMenu(user),
    });
    await ctx.answerCbQuery();
  } else {
    await ctx.reply(SIGNALS_MESSAGE, {
      parse_mode: 'Markdown',
      ...keyboards.signalsMenu(user),
    });
  }
}

async function toggleSignal(ctx, field, label) {
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) {
    await ctx.answerCbQuery('Ошибка');
    return;
  }

  user.signals[field] = !user.signals[field];
  await user.save();

  const status = user.signals[field] ? `✅ ${label} вкл` : `❌ ${label} выкл`;
  await ctx.answerCbQuery(status);

  await safeEditMessage(ctx, SIGNALS_MESSAGE, {
    parse_mode: 'Markdown',
    ...keyboards.signalsMenu(user),
  });
}

const handleToggleEth3 = (ctx) => toggleSignal(ctx, 'eth3candles', 'ETH 3с');
const handleToggleEth2 = (ctx) => toggleSignal(ctx, 'eth2candles', 'ETH 2с');
const handleToggleBtc3 = (ctx) => toggleSignal(ctx, 'btc3candles', 'BTC 3с');
const handleToggleBtc2 = (ctx) => toggleSignal(ctx, 'btc2candles', 'BTC 2с');

async function handleTrading(ctx) {
  const user = await getOrCreateUser(ctx);
  const stats = await TradingStats.getStats();
  
  const winRate = stats.totalTrades > 0 
    ? ((stats.wonTrades / stats.totalTrades) * 100).toFixed(1) 
    : '0';
  
  const pnlEmoji = stats.totalPnL >= 0 ? '📈' : '📉';
  const pnlSign = stats.totalPnL >= 0 ? '+' : '';
  
  const message = 
    `💰 *Торговля (эмуляция)*\n\n` +
    `💵 Баланс: *$${stats.currentBalance.toFixed(2)}*\n` +
    `${pnlEmoji} P&L: ${pnlSign}$${stats.totalPnL.toFixed(2)}\n\n` +
    `📊 Статистика:\n` +
    `• Всего сделок: ${stats.totalTrades}\n` +
    `• Побед: ${stats.wonTrades} (${winRate}%)\n` +
    `• Поражений: ${stats.lostTrades}\n` +
    `• Комиссии: $${stats.totalCommissions.toFixed(2)}\n\n` +
    `🎯 Победы по шагам:\n` +
    `• Step 1: ${stats.winsByStep[1] || 0}\n` +
    `• Step 2: ${stats.winsByStep[2] || 0}\n` +
    `• Step 3: ${stats.winsByStep[3] || 0}\n` +
    `• Step 4: ${stats.winsByStep[4] || 0}`;

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, message, {
      parse_mode: 'Markdown',
      ...keyboards.tradingMenu(user, stats),
    });
    await ctx.answerCbQuery();
  } else {
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...keyboards.tradingMenu(user, stats),
    });
  }
}

async function handleToggleTrading(ctx) {
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) {
    await ctx.answerCbQuery('Ошибка');
    return;
  }

  user.signals.tradingNotifications = !user.signals.tradingNotifications;
  await user.save();

  const status = user.signals.tradingNotifications 
    ? '✅ Уведомления о торговле вкл' 
    : '❌ Уведомления о торговле выкл';
  await ctx.answerCbQuery(status);

  const stats = await TradingStats.getStats();
  
  const winRate = stats.totalTrades > 0 
    ? ((stats.wonTrades / stats.totalTrades) * 100).toFixed(1) 
    : '0';
  
  const pnlEmoji = stats.totalPnL >= 0 ? '📈' : '📉';
  const pnlSign = stats.totalPnL >= 0 ? '+' : '';
  
  const message = 
    `💰 *Торговля (эмуляция)*\n\n` +
    `💵 Баланс: *$${stats.currentBalance.toFixed(2)}*\n` +
    `${pnlEmoji} P&L: ${pnlSign}$${stats.totalPnL.toFixed(2)}\n\n` +
    `📊 Статистика:\n` +
    `• Всего сделок: ${stats.totalTrades}\n` +
    `• Побед: ${stats.wonTrades} (${winRate}%)\n` +
    `• Поражений: ${stats.lostTrades}\n` +
    `• Комиссии: $${stats.totalCommissions.toFixed(2)}\n\n` +
    `🎯 Победы по шагам:\n` +
    `• Step 1: ${stats.winsByStep[1] || 0}\n` +
    `• Step 2: ${stats.winsByStep[2] || 0}\n` +
    `• Step 3: ${stats.winsByStep[3] || 0}\n` +
    `• Step 4: ${stats.winsByStep[4] || 0}`;

  await safeEditMessage(ctx, message, {
    parse_mode: 'Markdown',
    ...keyboards.tradingMenu(user, stats),
  });
}

async function handleBackToMain(ctx) {
  const user = await getOrCreateUser(ctx);
  
  const msg = 
    `👋 Привет, ${user.firstName || 'трейдер'}!\n\n` +
    `Бот для сигналов Polymarket.\n\n` +
    `Выбери действие:`;

  await safeEditMessage(ctx, msg, keyboards.mainMenu());
  await ctx.answerCbQuery();
}

module.exports = {
  handleStart,
  handleSignals,
  handleToggleEth3,
  handleToggleEth2,
  handleToggleBtc3,
  handleToggleBtc2,
  handleTrading,
  handleToggleTrading,
  handleBackToMain,
};
