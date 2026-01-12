// TODO: Раскомментировать когда MongoDB будет готова
// const User = require('../models/User');

const storage = require('../services/storage');
const keyboards = require('./keyboards');

// Debounce для /start - не отвечаем чаще чем раз в 2 секунды на пользователя
const lastStartTime = new Map();
const START_DEBOUNCE_MS = 2000;

/**
 * Безопасное редактирование сообщения (игнорирует ошибку "message is not modified")
 */
async function safeEditMessage(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, extra);
  } catch (error) {
    // Игнорируем ошибку если сообщение не изменилось
    if (!error.message?.includes('message is not modified')) {
      throw error;
    }
  }
}

/**
 * Команда /start
 */
async function handleStart(ctx) {
  const userId = ctx.from.id;
  const now = Date.now();
  
  // Debounce - игнорируем если прошло меньше 2 секунд
  const lastTime = lastStartTime.get(userId) || 0;
  if (now - lastTime < START_DEBOUNCE_MS) {
    console.log(`[START] Debounce: ignoring /start from ${userId} (too fast)`);
    return;
  }
  lastStartTime.set(userId, now);
  
  console.log(`[START] User ${userId} sent /start, update_id: ${ctx.update.update_id}`);
  
  const user = storage.getOrCreateUser(userId, {
    username: ctx.from.username,
    firstName: ctx.from.first_name,
  });
  
  const welcomeMessage = 
    `👋 Привет, ${user.firstName || 'трейдер'}!\n\n` +
    `Это бот для отслеживания сигналов на Polymarket.\n\n` +
    `Выбери действие:`;

  await ctx.reply(welcomeMessage, keyboards.mainMenu());
}

/**
 * Показать меню сигналов
 */
async function handleSignals(ctx) {
  const user = storage.getOrCreateUser(ctx.from.id, {
    username: ctx.from.username,
    firstName: ctx.from.first_name,
  });
  
  const message = 
    `📊 *Настройки сигналов*\n\n` +
    `Сигнал "3 свечи" отправляется когда:\n` +
    `• 2 предыдущие 15-мин свечи одного цвета\n` +
    `• Текущая свеча того же цвета >10 сек\n` +
    `• До конца рынка минимум 1 минута\n\n` +
    `Нажми на кнопку чтобы включить/выключить:`;

  if (ctx.callbackQuery) {
    await safeEditMessage(ctx, message, {
      parse_mode: 'Markdown',
      ...keyboards.signalsMenu(user),
    });
    await ctx.answerCbQuery();
  } else {
    await ctx.reply(message, {
      parse_mode: 'Markdown',
      ...keyboards.signalsMenu(user),
    });
  }
}

/**
 * Переключить сигнал ETH
 */
async function handleToggleEth(ctx) {
  const user = storage.toggleSignal(ctx.from.id, 'eth');
  
  if (!user) {
    await ctx.answerCbQuery('Ошибка: пользователь не найден');
    return;
  }

  const status = user.signals.eth3candles ? '✅ Сигнал ETH включён' : '❌ Сигнал ETH выключен';
  await ctx.answerCbQuery(status);

  // Обновляем клавиатуру
  const message = 
    `📊 *Настройки сигналов*\n\n` +
    `Сигнал "3 свечи" отправляется когда:\n` +
    `• 2 предыдущие 15-мин свечи одного цвета\n` +
    `• Текущая свеча того же цвета >10 сек\n` +
    `• До конца рынка минимум 1 минута\n\n` +
    `Нажми на кнопку чтобы включить/выключить:`;

  await safeEditMessage(ctx, message, {
    parse_mode: 'Markdown',
    ...keyboards.signalsMenu(user),
  });
}

/**
 * Переключить сигнал BTC
 */
async function handleToggleBtc(ctx) {
  const user = storage.toggleSignal(ctx.from.id, 'btc');
  
  if (!user) {
    await ctx.answerCbQuery('Ошибка: пользователь не найден');
    return;
  }

  const status = user.signals.btc3candles ? '✅ Сигнал BTC включён' : '❌ Сигнал BTC выключен';
  await ctx.answerCbQuery(status);

  // Обновляем клавиатуру
  const message = 
    `📊 *Настройки сигналов*\n\n` +
    `Сигнал "3 свечи" отправляется когда:\n` +
    `• 2 предыдущие 15-мин свечи одного цвета\n` +
    `• Текущая свеча того же цвета >10 сек\n` +
    `• До конца рынка минимум 1 минута\n\n` +
    `Нажми на кнопку чтобы включить/выключить:`;

  await safeEditMessage(ctx, message, {
    parse_mode: 'Markdown',
    ...keyboards.signalsMenu(user),
  });
}

/**
 * Вернуться в главное меню
 */
async function handleBackToMain(ctx) {
  const user = storage.getOrCreateUser(ctx.from.id, {
    username: ctx.from.username,
    firstName: ctx.from.first_name,
  });
  
  const welcomeMessage = 
    `👋 Привет, ${user.firstName || 'трейдер'}!\n\n` +
    `Это бот для отслеживания сигналов на Polymarket.\n\n` +
    `Выбери действие:`;

  await safeEditMessage(ctx, welcomeMessage, keyboards.mainMenu());
  await ctx.answerCbQuery();
}

module.exports = {
  handleStart,
  handleSignals,
  handleToggleEth,
  handleToggleBtc,
  handleBackToMain,
};
