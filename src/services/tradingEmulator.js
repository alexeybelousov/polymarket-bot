const config = require('../config');
const TradeSeries = require('../models/TradeSeries');
const TradingStats = require('../models/TradingStats');
const SignalLog = require('../models/SignalLog');
const User = require('../models/User');


// ===== НАСТРОЙКИ СТРАТЕГИИ =====
// Конфигурации для нескольких ботов
const TRADING_CONFIGS = {
  bot1: {
    name: '3 свечи, 2%, 4 шага, ≤$0.55',              // Имя бота для отображения
    firstBetPercent: 0.02,      // Первая ставка: 2% от депозита
    signalType: '3candles',     // На каком сигнале начинается торговля: 3 свечи
    maxSteps: 4,                // Количество шагов
    baseDeposit: 100,           // Базовый депозит: $100
    maxPrice: 0.55,             // Верхний предел цены (не входим если цена выше)
    entryFee: 0.015,            // Комиссия на вход: 1.5%
    exitFee: 0.015,             // Комиссия на выход: 1.5%
    buyStrategy: 'signal',      // Тип покупки: "signal" - покупаем сразу по сигналу, "validate" - валидируем рынок перед покупкой
  },
  bot2: {
    name: '2 свечи, 1.5%, 3 шага (break-even), ≤$0.55',              // Имя бота для отображения
    firstBetPercent: 0.015,     // Первая ставка: 1,5% от депозита
    signalType: '2candles',     // На каком сигнале начинается торговля: 2 свечи
    maxSteps: 3,                // Количество шагов
    baseDeposit: 100,           // Базовый депозит: $100
    maxPrice: 0.55,             // Верхний предел цены (не входим если цена выше)
    entryFee: 0.015,            // Комиссия на вход: 1.5%
    exitFee: 0.015,             // Комиссия на выход: 1.5%
    buyStrategy: 'signal',      // Тип покупки: "signal" - покупаем сразу по сигналу, "validate" - валидируем рынок перед покупкой
    breakEvenOnLastStep: true,  // На последнем шаге просто покрываем убытки без прибыли
    cooldownAfterFullLoss: 15 * 60 * 1000, // 15 минут в миллисекундах после полного проигрыша
  },
  bot3: {
    name: '2 свечи, 1.5%, 3 шага (validated), ≤$0.55',              // Имя бота для отображения
    firstBetPercent: 0.015,     // Первая ставка: 1,5% от депозита
    signalType: '2candles',     // На каком сигнале начинается торговля: 2 свечи
    maxSteps: 3,                // Количество шагов
    baseDeposit: 1000,           // Базовый депозит: $1000
    maxPrice: 0.55,             // Верхний предел цены (не входим если цена выше)
    entryFee: 0.015,            // Комиссия на вход: 1.5%
    exitFee: 0.015,             // Комиссия на выход: 1.5%
    buyStrategy: 'validate',  // Тип покупки: "signal" - покупаем сразу по сигналу, "validate" - валидируем рынок перед покупкой
    breakEvenOnLastStep: true,  // На последнем шаге просто покрываем убытки без прибыли
    cooldownAfterFullLoss: 15 * 60 * 1000, // 15 минут в миллисекундах после полного проигрыша
  },
};

/**
 * Динамический расчёт ставки на основе цены
 * Формула учитывает обе комиссии (entry и exit):
 * profitMultiplier = (1 - entryFee) * (1 - exitFee) / price - 1
 * betAmount = (previousLosses + targetProfit) / profitMultiplier
 */
function calculateDynamicBet(buyPrice, previousLosses, targetProfit, entryFeeRate, exitFeeRate) {
  // Учитываем обе комиссии: при покупке (entry) и при продаже (exit)
  const profitMultiplier = (1 - entryFeeRate) * (1 - exitFeeRate) / buyPrice - 1;
  if (profitMultiplier <= 0) {
    return null; // Невозможно получить профит при такой цене
  }
  const neededProfit = previousLosses + targetProfit;
  return neededProfit / profitMultiplier;
}

/**
 * Получить короткий хеш из tokenId (первые 5 символов)
 * Безопасно обрабатывает отсутствие tokenId для старых данных
 */
function getShortHash(tokenId) {
  if (!tokenId || typeof tokenId !== 'string') return '';
  return tokenId.substring(0, 7);
}

// Константы для конвертации времени
const MS_PER_MINUTE = 60 * 1000;

class TradingEmulator {
  constructor(bot, dataProvider, botId = 'bot1', config = TRADING_CONFIGS.bot1) {
    this.bot = bot;
    this.dataProvider = dataProvider;
    this.botId = botId;
    this.config = config;
    this.activeSeries = new Map(); // asset -> TradeSeries
    this.interval = null;
    
    // Локальные константы из конфига
    if (!config || !config.entryFee || !config.exitFee) {
      console.error(`[TRADE] [${botId}] Invalid config provided:`, config);
      throw new Error(`Invalid config for bot ${botId}: missing entryFee or exitFee`);
    }
    this.ENTRY_FEE_RATE = config.entryFee;
    this.EXIT_FEE_RATE = config.exitFee;
    
    // Значения по умолчанию для стратегий
    this.config.buyStrategy = this.config.buyStrategy || 'signal';
    
    console.log(`[TRADE] [${botId}] Initialized with ENTRY_FEE_RATE: ${this.ENTRY_FEE_RATE}, EXIT_FEE_RATE: ${this.EXIT_FEE_RATE}, buyStrategy: ${this.config.buyStrategy}`);
  }

  async start() {
    // Инициализируем статистику с правильным baseDeposit
    const stats = await TradingStats.getStats(this.botId);
    const baseDeposit = this.config.baseDeposit || 100;
    
    // Если статистика не инициализирована или имеет дефолтное значение, обновляем
    if (!stats.initialDeposit || stats.initialDeposit === 100) {
      // Если это новый бот или база была сброшена, устанавливаем правильный депозит
      if (stats.initialDeposit !== baseDeposit) {
        stats.initialDeposit = baseDeposit;
        // Если баланс равен дефолтному 100 и нет торгов, обновляем баланс тоже
        if (stats.currentBalance === 100 && stats.totalTrades === 0 && stats.totalPnL === 0) {
          stats.currentBalance = baseDeposit;
        }
        await stats.save();
        console.log(`💰 [${this.botId}] Initialized stats with baseDeposit: $${baseDeposit}`);
      }
    }
    
    // Дополнительная проверка: если баланс все еще 100, а должен быть другой, обновляем
    if (stats.currentBalance === 100 && baseDeposit !== 100 && stats.totalTrades === 0 && stats.totalPnL === 0) {
      stats.currentBalance = baseDeposit;
      stats.initialDeposit = baseDeposit;
      await stats.save();
      console.log(`💰 [${this.botId}] Fixed stats: updated balance from $100 to $${baseDeposit}`);
    }
    
    // Загружаем активные серии из БД для этого бота
    console.log(`💰 [${this.botId}] Loading active series from DB...`);
    const series = await TradeSeries.find({ botId: this.botId, status: 'active' });
    console.log(`💰 [${this.botId}] Found ${series.length} active series`);
    
    for (const s of series) {
      this.activeSeries.set(s.asset, s);
      console.log(`💰 [${this.botId}] Resumed ${s.asset.toUpperCase()} series at Step ${s.currentStep}`);
    }
    
    // Загружаем активные cooldown серии
    const cooldownSeries = await TradeSeries.find({ botId: this.botId, status: 'cooldown' });
    console.log(`💰 [${this.botId}] Found ${cooldownSeries.length} cooldown series in DB`);
    const now = new Date();
    for (const s of cooldownSeries) {
      // Проверяем, не истек ли cooldown
      if (s.endedAt && new Date(s.endedAt) > now) {
        this.activeSeries.set(s.asset, s);
        const remainingMs = new Date(s.endedAt) - now;
        const remainingMin = Math.ceil(remainingMs / MS_PER_MINUTE);
        console.log(`💰 [${this.botId}] Resumed ${s.asset.toUpperCase()} cooldown (${remainingMin} min remaining)`);
      } else {
        // Cooldown истек, закрываем его
        await this.endCooldown(s);
        console.log(`💰 [${this.botId}] ${s.asset.toUpperCase()} cooldown expired, ended`);
      }
    }
    
    console.log(`💰 [${this.botId}] Trading emulator started`);
    this.interval = setInterval(() => this.tick(), 5000);
  }

  // Логирование в SignalLog
  async log(type, marketSlug, reason, data = {}) {
    try {
      await SignalLog.create({
        botId: this.botId,
        type: type || 'unknown',
        marketSlug: marketSlug || 'unknown',
        action: 'trade',
        reason,
        data,
      });
    } catch (e) {
      console.error(`[${this.botId}] Error saving trade log:`, e.message);
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log(`🛑 [${this.botId}] Trading emulator stopped`);
    }
  }

  // ==================== УТИЛИТЫ ====================
  
  /**
   * Завершить cooldown серию
   */
  async endCooldown(cooldownSeries) {
    if (cooldownSeries.status !== 'cooldown') return;
    
    cooldownSeries.status = 'cooldown'; // Оставляем статус cooldown
    cooldownSeries.endedAt = new Date();
    cooldownSeries.addEvent('cooldown_ended', {
      message: `⏸️ Cooldown завершен`,
    });
    
    await cooldownSeries.save();
    console.log(`[TRADE] [${this.botId}] ${cooldownSeries.asset.toUpperCase()}: Cooldown ended`);
  }
  
  /**
   * Создать cooldown серию для валюты
   */
  async createCooldown(asset) {
    // Проверяем, нет ли уже активной cooldown серии в activeSeries
    if (this.activeSeries.has(asset)) {
      const existingSeries = this.activeSeries.get(asset);
      if (existingSeries.status === 'cooldown') {
        // Проверяем, не истек ли cooldown
        if (existingSeries.endedAt && new Date(existingSeries.endedAt) > new Date()) {
          console.log(`[TRADE] [${this.botId}] ${asset.toUpperCase()}: Cooldown already exists in activeSeries`);
          return existingSeries;
        } else {
          // Cooldown истек, закрываем его
          await this.endCooldown(existingSeries);
          this.activeSeries.delete(asset);
        }
      }
    }
    
    // Проверяем, нет ли активной cooldown серии в БД
    const existingCooldown = await TradeSeries.findOne({
      botId: this.botId,
      asset,
      status: 'cooldown',
    });
    
    if (existingCooldown) {
      // Проверяем, не истек ли cooldown
      if (existingCooldown.endedAt && new Date(existingCooldown.endedAt) > new Date()) {
        // Cooldown активен, добавляем в activeSeries
        this.activeSeries.set(asset, existingCooldown);
        console.log(`[TRADE] [${this.botId}] ${asset.toUpperCase()}: Cooldown already exists in DB, added to activeSeries`);
        return existingCooldown;
      } else {
        // Cooldown истек, закрываем его
        await this.endCooldown(existingCooldown);
      }
    }
    
    const cooldownDuration = this.config.cooldownAfterFullLoss || 0;
    if (!cooldownDuration || cooldownDuration <= 0) {
      console.log(`[TRADE] [${this.botId}] ${asset.toUpperCase()}: Cooldown not configured (cooldownAfterFullLoss: ${cooldownDuration})`);
      return null; // Cooldown не настроен
    }
    
    const now = new Date();
    const endedAt = new Date(now.getTime() + cooldownDuration);
    const cooldownMinutes = Math.ceil(cooldownDuration / MS_PER_MINUTE);
    
    const cooldownSeries = new TradeSeries({
      botId: this.botId,
      asset,
      signalColor: 'unknown', // Не важно для cooldown
      betColor: 'unknown', // Не важно для cooldown
      status: 'cooldown',
      currentStep: 0,
      totalInvested: 0,
      totalPnL: 0,
      startedAt: now,
      endedAt,
    });
    
    cooldownSeries.addEvent('cooldown_started', {
      message: `⏸️ Cooldown начат (${cooldownMinutes} мин)`,
    });
    
    await cooldownSeries.save();
    this.activeSeries.set(asset, cooldownSeries);
    
    console.log(`[TRADE] [${this.botId}] ${asset.toUpperCase()}: Cooldown created until ${endedAt.toISOString()}`);
    return cooldownSeries;
  }
  
  /**
   * Конвертирует slug из формата Binance в формат Polymarket
   * Binance: binance-btcusdt-1768309200000 (миллисекунды)
   * Polymarket: btc-updown-15m-1768309200 (секунды)
   */
  convertToPolymarketSlug(slug) {
    if (!slug || typeof slug !== 'string') {
      console.warn(`[TRADE] [${this.botId}] Invalid slug provided to convertToPolymarketSlug:`, slug);
      return slug || '';
    }
    if (!slug.startsWith('binance-')) {
      return slug; // Уже в формате Polymarket
    }
    
    // Извлекаем timestamp (в миллисекундах)
    const match = slug.match(/^binance-(ethusdt|btcusdt)-(\d+)$/);
    if (!match) {
      console.warn(`[TRADE] Cannot parse Binance slug: ${slug}`);
      return slug;
    }
    
    const [, symbol, timestampMs] = match;
    const timestampSec = Math.floor(parseInt(timestampMs) / 1000);
    const asset = symbol === 'ethusdt' ? 'eth' : 'btc';
    
    return `${asset}-updown-15m-${timestampSec}`;
  }

  // ==================== СИГНАЛ ====================
  
  async onSignal(type, signalColor, signalMarketSlug, nextMarketSlug, signalType = '3candles') {
    console.log(`[TRADE] [${this.botId}] Received signal: ${type.toUpperCase()} ${signalType} ${signalColor} (config: ${this.config.signalType})`);
    
    // Проверяем тип сигнала - бот торгует только на сигналы, соответствующие его конфигу
    if (this.config.signalType !== signalType) {
      console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Signal type mismatch (${signalType} !== ${this.config.signalType}), skipping`);
      return; // Пропускаем сигналы, которые не соответствуют конфигу бота
    }
    
    console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Signal type matches, proceeding...`);
    
    // Проверяем нет ли активной серии в activeSeries
    if (this.activeSeries.has(type)) {
      const existingSeries = this.activeSeries.get(type);
      // Если это cooldown серия, проверяем не истекла ли она
      if (existingSeries.status === 'cooldown') {
        if (existingSeries.endedAt && new Date(existingSeries.endedAt) > new Date()) {
          const remainingMs = new Date(existingSeries.endedAt) - new Date();
          const remainingMin = Math.ceil(remainingMs / MS_PER_MINUTE);
          console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Cooldown active (${remainingMin} min remaining), skipping signal`);
          return;
        } else {
          // Cooldown истек, но серия еще не закрыта - закроем её
          await this.endCooldown(existingSeries);
          this.activeSeries.delete(type);
        }
      } else {
        console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Already active series, skipping`);
        return;
      }
    } else {
      // Проверяем, нет ли активной cooldown серии в БД (на случай если бот перезапустился)
      const existingCooldown = await TradeSeries.findOne({
        botId: this.botId,
        asset: type,
        status: 'cooldown',
      });
      
      if (existingCooldown) {
        // Проверяем, не истек ли cooldown
        if (existingCooldown.endedAt && new Date(existingCooldown.endedAt) > new Date()) {
          // Cooldown активен, добавляем в activeSeries и пропускаем сигнал
          this.activeSeries.set(type, existingCooldown);
          const remainingMs = new Date(existingCooldown.endedAt) - new Date();
          const remainingMin = Math.ceil(remainingMs / MS_PER_MINUTE);
          console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Cooldown found in DB (${remainingMin} min remaining), skipping signal`);
          return;
        } else {
          // Cooldown истек, закрываем его
          await this.endCooldown(existingCooldown);
        }
      }
    }

    const betColor = signalColor === 'green' ? 'red' : 'green';
    const betEmoji = betColor === 'green' ? '🟢' : '🔴';
    const signalEmoji = signalColor === 'green' ? '🟢' : '🔴';
    const betOutcome = betColor === 'green' ? 'up' : 'down';
    
    // Получаем цену для проверки максимального лимита
    const polySlug = this.convertToPolymarketSlug(nextMarketSlug);
    let buyPrice = null;
    let errorReason = 'unknown';
    let errorMessage = '';
    
    try {
      const polymarket = require('./polymarket');
      const priceData = await polymarket.getBuyPrice(polySlug, betOutcome);
      if (priceData && priceData.price) {
        buyPrice = priceData.price;
      } else {
        errorReason = 'price_unavailable';
        errorMessage = `Не удалось получить цену для ${polySlug}`;
      }
    } catch (error) {
      console.error(`[TRADE] [${this.botId}] Error getting price for check:`, error.message);
      if (error.response?.status === 404) {
        errorReason = 'market_not_found';
        errorMessage = `Рынок ${polySlug} не найден в Polymarket`;
      } else {
        errorReason = 'api_error';
        errorMessage = `Ошибка API: ${error.message}`;
      }
    }
    
    if (!buyPrice) {
      const reasonText = errorReason === 'market_not_found' 
        ? `MARKET_NOT_FOUND: ${errorMessage}`
        : `CANNOT_GET_PRICE: ${errorMessage || `Не удалось получить цену для ${polySlug}`}`;
      console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Cannot get price (${errorReason}), skipping`);
      await this.log(type, polySlug, reasonText, {
        action: 'price_check_failed',
        betOutcome,
        errorReason,
        errorMessage,
      });
      return;
    }
    
    // Проверяем верхний предел цены
    if (buyPrice > this.config.maxPrice) {
      console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Price too high - $${buyPrice.toFixed(3)} > $${this.config.maxPrice} (max limit), skipping`);
      return;
    }
    
    console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Price OK ($${buyPrice.toFixed(3)}), creating series...`);
    
    // Создаём серию
    const series = new TradeSeries({
      botId: this.botId,
      asset: type,
      signalMarketSlug: signalMarketSlug, // Рынок где сигнал (для отслеживания отмены)
      signalColor,
      betColor,
      currentStep: 1,
      currentMarketSlug: nextMarketSlug,
      marketState: 'waiting',
    });
    
    // Событие: серия открыта
    const candleCount = signalType === '3candles' ? '3' : '2';
    series.addEvent('series_opened', {
      message: `Сигнал ${candleCount} ${signalEmoji} → ставим на ${betEmoji}`,
    });
    
    console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Series created, buyStrategy: ${this.config.buyStrategy || 'signal'}`);
    
    // Покупаем первую ставку в зависимости от стратегии
    if (this.config.buyStrategy === 'validate') {
      // Начинаем валидацию рынка (валидируем рынок где сигнал)
      series.validationState = 'validating';
      series.validationMarketSlug = signalMarketSlug; // Валидируем рынок где сигнал
      series.validationHistory = [];
      series.lastValidationCheck = null;
      
      // Добавляем событие валидации
      const signalEmoji = series.signalColor === 'red' ? '🔴' : '🟢';
      series.addEvent('validation_started', {
        message: `Проверяю сигнал "${signalEmoji}":`,
      });
      // Сохраняем индекс последнего события (validation_started)
      series.validationEventIndex = series.events.length - 1;
      
      // НЕ вызываем buyStep() - ждем валидации
      await series.save();
      this.activeSeries.set(type, series);
      
      console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Started validation for signal market ${signalMarketSlug}`);
      await this.notifyUsers(series, 'Валидация рынка...');
      return; // Выходим, не покупаем сразу
    } else {
      // buyStrategy === 'signal' (по умолчанию) - покупаем сразу по сигналу
      const bought = await this.buyStep(series);
      
      console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: buyStep returned: ${bought}`);
      if (!bought) {
        // Не удалось купить — отменяем серию
        series.status = 'cancelled';
        series.endedAt = new Date();
        series.addEvent('series_cancelled', {
          message: '⛔ Серия отменена: не удалось купить (нет цены или баланса)',
        });
        
        // Обновляем статистику
        const stats = await TradingStats.getStats(this.botId);
        stats.cancelledTrades++;
        await stats.save();
        
        await series.save();
        console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Series cancelled - could not buy`);
        await this.notifyUsers(series, '⛔ Серия отменена');
        return;
      }
      
      await series.save();
      this.activeSeries.set(type, series);
      
      console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Series opened, betting ${betEmoji} ${betColor.toUpperCase()}`);
      await this.notifyUsers(series, 'Серия открыта');
    }
  }

  // ==================== ПОКУПКА СТАВКИ ====================
  
  async buyStep(series, marketSlugOverride = null) {
    // Проверка что this определен
    if (!this || !this.ENTRY_FEE_RATE) {
      console.error(`[TRADE] [${this?.botId || 'unknown'}] ERROR: this.ENTRY_FEE_RATE is undefined!`);
      console.error(`[TRADE] this:`, this);
      throw new Error('this.ENTRY_FEE_RATE is undefined');
    }
    
    const stats = await TradingStats.getStats(this.botId);
    const betEmoji = series.betColor === 'green' ? '🟢' : '🔴';
    const betOutcome = series.betColor === 'green' ? 'up' : 'down';
    
    // Получаем цену с Polymarket (торгуем всегда на Polymarket, даже если сигналы с Binance)
    const targetSlug = marketSlugOverride || series.currentMarketSlug;
    // Конвертируем slug из формата binance в polymarket
    const polySlug = this.convertToPolymarketSlug(targetSlug);
    
    let price = null;
    let tokenId = null;
    let errorReason = 'unknown';
    let errorMessage = '';
    
    try {
      const polymarket = require('./polymarket');
      const priceData = await polymarket.getBuyPrice(polySlug, betOutcome);
      if (priceData && priceData.price) {
        price = priceData.price;
        tokenId = priceData.tokenId;
        console.log(`[TRADE] [${this.botId}] Got Polymarket price for ${polySlug}: $${price.toFixed(3)} (tokenId: ${tokenId})`);
      } else {
        errorReason = 'price_unavailable';
        errorMessage = `Не удалось получить цену для ${polySlug}`;
      }
    } catch (error) {
      console.error(`[TRADE] [${this.botId}] Error getting Polymarket price for ${polySlug}:`, error.message);
      if (error.response?.status === 404) {
        errorReason = 'market_not_found';
        errorMessage = `Рынок ${polySlug} не найден в Polymarket`;
      } else {
        errorReason = 'api_error';
        errorMessage = `Ошибка API: ${error.message}`;
      }
    }
    
    // Если цена не получена — отменяем покупку
    if (!price) {
      const reasonText = errorReason === 'market_not_found' 
        ? `MARKET_NOT_FOUND: ${errorMessage} (Step ${series.currentStep})`
        : `CANNOT_GET_PRICE: ${errorMessage || `Не удалось получить цену для ${polySlug}`} (Step ${series.currentStep})`;
      console.warn(`[TRADE] [${this.botId}] Cannot get price for ${polySlug} (${errorReason}), skipping buy`);
      series.addEvent('price_error', {
        message: `❌ Не удалось получить цену для ${polySlug}`,
        slug: polySlug,
      });
      await this.log(series.asset, polySlug, reasonText, {
        action: 'buy_failed',
        step: series.currentStep,
        seriesId: series._id,
        errorReason,
        errorMessage,
      });
      return false;
    }
    
    // Проверяем верхний предел цены (на каждом шаге)
    if (price > this.config.maxPrice) {
      console.log(`[TRADE] [${this.botId}] ${series.asset.toUpperCase()}: Price too high on Step ${series.currentStep} - $${price.toFixed(3)} > $${this.config.maxPrice}, cancelling`);
      
      // Добавляем событие в таймлайн
      series.addEvent('series_cancelled', {
        message: `⛔ Не удалось купить: цена превысила лимит ($${price.toFixed(3)} > $${this.config.maxPrice}) на Step ${series.currentStep}`,
        marketColor: null,
        pnl: -(series.totalInvested || 0),
      });
      
      series.status = 'cancelled';
      series.endedAt = new Date();
      
      const stats = await TradingStats.getStats(this.botId);
      stats.cancelledTrades++;
      await stats.save();
      
      await series.save();
      this.activeSeries.delete(series.asset);
      
      await this.log(series.asset, polySlug, `PRICE_TOO_HIGH: $${price.toFixed(3)} > $${this.config.maxPrice}`, {
        step: series.currentStep,
        price,
        maxPrice: this.config.maxPrice,
        totalInvested: series.totalInvested,
      });
      
      await this.notifyUsers(series, '⛔ Серия отменена: цена превысила лимит');
      return false;
    }
    
    // Рассчитываем ставку динамически
    // Используем текущий баланс для расчёта первой ставки (2% от баланса)
    const deposit = stats.currentBalance || this.config.baseDeposit;
    const previousLosses = series.totalInvested || 0;
    const firstBetAmount = deposit * this.config.firstBetPercent;
    
    // Если это последний шаг и breakEvenOnLastStep = true, то просто покрываем убытки без прибыли
    let targetProfit;
    if (series.currentStep === this.config.maxSteps && this.config.breakEvenOnLastStep) {
      targetProfit = 0; // Просто покрываем убытки, без прибыли
      console.log(`[TRADE] [${this.botId}] ${series.asset.toUpperCase()}: Last step (${series.currentStep}), breakEven mode - no profit, just covering losses`);
    } else {
      // Фиксированный профит 1.5% от депозита
      targetProfit = this.config.baseDeposit * 0.015; // $1.50 при депозите $100
      console.log(`[TRADE] [${this.botId}] ${series.asset.toUpperCase()}: Target profit: $${targetProfit.toFixed(2)} (1.5% of $${this.config.baseDeposit})`);
    }
    
    const amount = calculateDynamicBet(price, previousLosses, targetProfit, this.ENTRY_FEE_RATE, this.EXIT_FEE_RATE);
    
    if (!amount || amount <= 0) {
      console.warn(`[TRADE] Cannot calculate bet amount at price $${price.toFixed(3)}`);
      series.addEvent('price_error', {
        message: `❌ Невозможно рассчитать ставку при цене $${price.toFixed(3)}`,
      });
      return false;
    }
    
    // Проверяем баланс
    if (stats.currentBalance < amount) {
      series.addEvent('insufficient_balance', {
        amount,
        message: `Недостаточно средств: нужно $${amount.toFixed(2)}, есть $${stats.currentBalance.toFixed(2)}`,
      });
      series.status = 'cancelled';
      series.endedAt = new Date();
      
      const stats = await TradingStats.getStats(this.botId);
      stats.cancelledTrades++;
      await stats.save();
      
      await series.save();
      this.activeSeries.delete(series.asset);
      return false;
    }
    
    // Расчёты по формуле Polymarket
    const entryFee = amount * this.ENTRY_FEE_RATE;
    const netAmount = amount - entryFee;
    const shares = netAmount / price;
    
    // Списываем с баланса (amount включает комиссию)
    stats.currentBalance -= amount;
    await stats.save();
    
    // Сохраняем позицию
    series.positions.push({
      step: series.currentStep,
      marketSlug: series.currentMarketSlug,  // Рынок где была куплена позиция
      tokenId,                                // ID токена для отслеживания
      amount,
      price,
      shares,
      commission: entryFee,
      status: 'active',
    });
    
    series.totalInvested += amount;
    series.totalCommission += entryFee;
    
    // Событие: купили
    const priceHash = getShortHash(tokenId);
    const breakEvenNote = (series.currentStep === this.config.maxSteps && this.config.breakEvenOnLastStep) ? ' break-even' : '';
    series.addEvent('buy', {
      amount,
      message: `Купил ${shares.toFixed(2)} shares по $${price.toFixed(2)} (${priceHash}) = $${amount.toFixed(2)} на ${betEmoji} (Step ${series.currentStep}${breakEvenNote})`,
    });
    
    // Событие: ждём рынок
    series.marketState = 'waiting';
    series.addEvent('waiting_market', {
      message: `Жду начало рынка...`,
    });
    
    console.log(`[TRADE] [${this.botId}] ${series.asset.toUpperCase()}: Buy ${shares.toFixed(2)} shares- по $${price.toFixed(2)} = $${amount} (Step ${series.currentStep})`);
    await this.log(series.asset, series.currentMarketSlug, `BUY Step ${series.currentStep}: ${shares.toFixed(2)} shares- по $${price.toFixed(2)} = $${amount}`, { step: series.currentStep, amount, price, shares });
    return true;
  }

  // ==================== РАННЯЯ ПОКУПКА (ХЕДЖИРОВАНИЕ) ====================
  
  async buyNextStepEarly(series, context) {
    const asset = series.asset.toUpperCase();
    const nextStep = series.currentStep + 1;
    
    // Проверяем, что следующий шаг не превышает максимальное количество шагов
    if (nextStep > this.config.maxSteps) {
      console.log(`[TRADE] [${this.botId}] ${asset}: Cannot buy hedge - next step ${nextStep} exceeds maxSteps ${this.config.maxSteps}`);
      return;
    }
    
    const stats = await TradingStats.getStats(this.botId);
    const betEmoji = series.betColor === 'green' ? '🟢' : '🔴';
    const betOutcome = series.betColor === 'green' ? 'up' : 'down';
    const signalEmoji = series.signalColor === 'green' ? '🟢' : '🔴';
    
    // Получаем цену с Polymarket
    const polySlug = this.convertToPolymarketSlug(context.slugs.next);
    
    let price = null;
    let tokenId = null;
    let errorReason = 'unknown';
    let errorMessage = '';
    
    try {
      const polymarket = require('./polymarket');
      const priceData = await polymarket.getBuyPrice(polySlug, betOutcome);
      if (priceData && priceData.price) {
        price = priceData.price;
        tokenId = priceData.tokenId;
        console.log(`[TRADE] [${this.botId}] Got Polymarket price for hedge ${polySlug}: $${price.toFixed(3)} (tokenId: ${tokenId})`);
      } else {
        errorReason = 'price_unavailable';
        errorMessage = `Не удалось получить цену хеджа для ${polySlug}`;
      }
    } catch (error) {
      console.error(`[TRADE] [${this.botId}] Error getting Polymarket price for hedge ${polySlug}:`, error.message);
      if (error.response?.status === 404) {
        errorReason = 'market_not_found';
        errorMessage = `Рынок ${polySlug} не найден в Polymarket`;
      } else {
        errorReason = 'api_error';
        errorMessage = `Ошибка API: ${error.message}`;
      }
    }
    
    // Если цена не получена — отменяем хедж
    if (!price) {
      const reasonText = errorReason === 'market_not_found' 
        ? `MARKET_NOT_FOUND_HEDGE: ${errorMessage} (Step ${nextStep})`
        : `CANNOT_GET_PRICE_HEDGE: ${errorMessage || `Не удалось получить цену хеджа для ${polySlug}`} (Step ${nextStep})`;
      console.warn(`[TRADE] [${this.botId}] Cannot get price for hedge ${polySlug} (${errorReason}), skipping`);
      series.addEvent('price_error', {
        message: `❌ Не удалось получить цену хеджа для ${polySlug}`,
        slug: polySlug,
      });
      await this.log(asset, polySlug, reasonText, {
        action: 'hedge_failed',
        step: nextStep,
        seriesId: series._id,
        errorReason,
        errorMessage,
      });
      await series.save();
      return;
    }
    
    // Проверяем верхний предел цены
    if (price > this.config.maxPrice) {
      console.log(`[TRADE] [${this.botId}] ${asset}: Hedge price too high - $${price.toFixed(3)} > $${this.config.maxPrice}, skipping`);
      series.addEvent('price_error', {
        message: `⛔ Хедж отменён: цена превысила лимит ($${price.toFixed(3)} > $${this.config.maxPrice})`,
      });
      await series.save();
      return;
    }
    
    // Рассчитываем ставку динамически
    // Используем текущий баланс для расчёта первой ставки
    const deposit = stats.currentBalance || this.config.baseDeposit;
    const previousLosses = series.totalInvested || 0;
    const firstBetAmount = deposit * this.config.firstBetPercent;
    
    // Если следующий шаг - последний и breakEvenOnLastStep = true, то просто покрываем убытки без прибыли
    let targetProfit;
    if (nextStep === this.config.maxSteps && this.config.breakEvenOnLastStep) {
      targetProfit = 0; // Просто покрываем убытки, без прибыли
      console.log(`[TRADE] [${this.botId}] ${asset}: Hedge for last step (${nextStep}), breakEven mode - no profit, just covering losses`);
    } else {
      // Фиксированный профит 1.5% от депозита
      targetProfit = this.config.baseDeposit * 0.015; // $1.50 при депозите $100
      console.log(`[TRADE] [${this.botId}] ${asset}: Hedge target profit: $${targetProfit.toFixed(2)} (1.5% of $${this.config.baseDeposit})`);
    }
    
    const amount = calculateDynamicBet(price, previousLosses, targetProfit, this.ENTRY_FEE_RATE, this.EXIT_FEE_RATE);
    
    if (!amount || amount <= 0) {
      console.warn(`[TRADE] Cannot calculate hedge bet amount at price $${price.toFixed(3)}`);
      series.addEvent('price_error', {
        message: `❌ Невозможно рассчитать хедж при цене $${price.toFixed(3)}`,
      });
      await series.save();
      return;
    }
    
    // Проверяем баланс
    if (stats.currentBalance < amount) {
      series.addEvent('insufficient_balance', {
        amount,
        message: `Не хватает средств на хедж Step ${nextStep}`,
      });
      await series.save();
      return;
    }
    
    // Расчёты
    const entryFee = amount * this.ENTRY_FEE_RATE;
    const netAmount = amount - entryFee;
    const shares = netAmount / price;
    
    // Списываем с баланса
    stats.currentBalance -= amount;
    await stats.save();
    
    // Сохраняем позицию хеджа
    series.positions.push({
      step: nextStep,
      marketSlug: context.slugs.next,  // Рынок где была куплена позиция
      tokenId,                          // ID токена для отслеживания
      amount,
      price,
      shares,
      commission: entryFee,
      status: 'active',
    });
    
    series.totalInvested += amount;
    series.totalCommission += entryFee;
    series.nextStepBought = true;
    series.nextMarketSlug = context.slugs.next;
    
    // Событие: ранняя покупка
    const priceHash = getShortHash(tokenId);
    const breakEvenNote = (nextStep === this.config.maxSteps && this.config.breakEvenOnLastStep) ? ' break-even' : '';
    series.addEvent('buy', {
      amount,
      step: nextStep,
      message: `⚡ Хедж: ${shares.toFixed(2)} shares- по $${price.toFixed(2)} (${priceHash}) = $${amount.toFixed(2)} на ${betEmoji} (Step ${nextStep}${breakEvenNote})`,
    });
    
    await series.save();
    console.log(`[TRADE] [${this.botId}] ${asset}: ⚡ HEDGE - ${shares.toFixed(2)} shares- по $${price.toFixed(2)} = $${amount} (Step ${nextStep})`);
    await this.log(series.asset, series.nextMarketSlug, `HEDGE Step ${nextStep}: ${shares.toFixed(2)} shares- по $${price.toFixed(2)} = $${amount}`, { step: nextStep, amount, price, shares });
    await this.notifyUsers(series, `⚡ Хедж Step ${nextStep}`);
  }

  // ==================== ВАЛИДАЦИЯ РЫНКА ====================
  
  /**
   * Анализ order book
   */
  analyzeOrderBook(bids, asks) {
    if (!bids || !asks || bids.length === 0 || asks.length === 0) {
      return null;
    }
    
    const bidsTotal = bids.reduce((sum, b) => sum + b.size, 0);
    const asksTotal = asks.reduce((sum, a) => sum + a.size, 0);
    const totalSize = bidsTotal + asksTotal;
    
    // Лучшие цены
    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 0;
    const spread = bestAsk - bestBid;
    
    // Баланс order book
    const bidRatio = bidsTotal / totalSize;
    const askRatio = asksTotal / totalSize;
    
    // Анализ ликвидности на ключевых уровнях
    const nearBestBid = bids.slice(0, 5).reduce((sum, b) => sum + b.size, 0);
    const nearBestAsk = asks.slice(0, 5).reduce((sum, a) => sum + a.size, 0);
    
    return {
      bidsTotal,
      asksTotal,
      totalSize,
      bestBid,
      bestAsk,
      spread,
      bidRatio,
      askRatio,
      nearBestBid,
      nearBestAsk,
      imbalance: (asksTotal - bidsTotal) / totalSize, // Положительное = больше продавцов (asks > bids), отрицательное = больше покупателей (bids > asks)
    };
  }
  
  /**
   * Проверка стабильности рынка (из monitor-signal-cancel.js)
   */
  checkStability(history, signalColor) {
    if (history.length < 3) {
      return { stable: false, reason: 'Недостаточно данных' };
    }
    
    // Берем последние 12 записей (2 минуты при интервале 10 сек)
    const recent = history.slice(-12);
    if (recent.length < 3) {
      return { stable: false, reason: 'Недостаточно данных' };
    }
    
    const prices = recent.map(r => r.price).filter(p => p > 0);
    if (prices.length < 3) {
      return { stable: false, reason: 'Недостаточно цен' };
    }
    
    // ЛОГИКА: для обоих сигналов рост цены мониторинга = отмена сигнала
    // GREEN сигнал (ставим на RED/down): если цена DOWN растет → сигнал отменяется
    // RED сигнал (ставим на GREEN/up): если цена UP растет → сигнал отменяется
    // Для обоих: цена должна падать или быть стабильной на низком уровне → сигнал подтверждается
    const firstPrice = prices[0];
    const lastPrice = prices[prices.length - 1];
    const change = lastPrice - firstPrice;
    const changePercent = firstPrice > 0 ? (change / firstPrice) * 100 : 0;
    
    // Проверяем тренд (цена не должна расти)
    let trendOk = true;
    let hasGrowth = false;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > prices[i - 1] + 0.001) { // Небольшой порог для учета колебаний
        hasGrowth = true;
        // Если цена выросла более чем на 5% от начальной - это плохо (отмена сигнала)
        if (firstPrice > 0 && ((prices[i] - firstPrice) / firstPrice) * 100 > 5) {
          trendOk = false;
          break;
        }
      }
    }
    
    // Проверяем order book
    const lastOrderBook = recent[recent.length - 1]?.orderBook;
    let orderBookOk = false;
    let orderBookImbalance = 0;
    if (lastOrderBook) {
      // Используем imbalance из analyzeOrderBook: (asks - bids) / totalSize
      // Положительный = больше продавцов (asks > bids) → цена падает → хорошо для обоих сигналов
      // Отрицательный = больше покупателей (bids > asks) → цена растет → плохо для обоих сигналов
      orderBookImbalance = lastOrderBook.imbalance || 0;
      
      // Для ОБОИХ сигналов: больше продавцов = хорошо (цена падает, сигнал подтверждается)
      // imbalance > 0 означает больше продавцов
      if (orderBookImbalance > 0.5) {
        orderBookOk = true;
      } else if (orderBookImbalance > 0.1) {
        orderBookOk = true;
      }
    }
    
    // Если цена очень низкая (< $0.05) и стабильна - это может быть стабильно
    const isVeryLowPrice = lastPrice < 0.05;
    const isPriceStable = Math.abs(changePercent) < 5; // Изменение менее 5%
    
    // Если цена очень высокая (> $0.95) и стабильна - это тоже может быть стабильно
    const isVeryHighPrice = lastPrice > 0.95;
    
    // ПРИОРИТЕТНАЯ ПРОВЕРКА: абсолютное значение цены
    // Мониторим ТЕКУЩИЙ рынок (где был сигнал), а не следующий (где ставим)
    // Для RED сигнала: если цена UP > 0.5 на текущем рынке, это означает что рынок уже ушел в GREEN → RED сигнал отменяется (stable = false)
    if (signalColor === 'red' && lastPrice > 0.5) {
      return {
        stable: false,
        reason: `Цена UP ($${lastPrice.toFixed(4)}) выше $0.50 - рынок ушел в GREEN, сигнал RED отменяется`,
        changePercent,
      };
    }
    
    // Для GREEN сигнала: если цена DOWN > 0.5 на текущем рынке, это означает что рынок уже ушел в RED → GREEN сигнал отменяется (stable = false)
    if (signalColor === 'green' && lastPrice > 0.5) {
      return {
        stable: false,
        reason: `Цена DOWN ($${lastPrice.toFixed(4)}) выше $0.50 - рынок ушел в RED, сигнал GREEN отменяется`,
        changePercent,
      };
    }
    
    // ПРИОРИТЕТ: Для очень низких цен (< $0.1) используем абсолютное изменение, а не процентное
    // Это должно быть ПЕРЕД проверкой на процентный рост, чтобы избежать ложных срабатываний
    if (isVeryLowPrice) {
      const absoluteChange = change;
      // Если цена выросла более чем на $0.05 или стала > $0.1 - это отмена
      if (absoluteChange > 0.05 || lastPrice > 0.1) {
        return {
          stable: false,
          reason: `Цена выросла с $${firstPrice.toFixed(4)} до $${lastPrice.toFixed(4)} (${changePercent.toFixed(2)}%) - возможна отмена`,
          changePercent,
        };
      }
      // Если цена очень низкая (< $0.1) и order book подтверждает (больше продавцов) - стабильно
      if (orderBookOk) {
        return {
          stable: true,
          reason: `Цена очень низкая ($${lastPrice.toFixed(4)}), order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%) - сигнал подтверждается`,
          changePercent,
        };
      }
    }
    
    // ВАЖНО: Если текущая цена низкая (< $0.3) и order book подтверждает - стабильно,
    // даже если был рост в середине окна (цена могла упасть обратно)
    if (lastPrice < 0.3 && orderBookOk) {
      return {
        stable: true,
        reason: `Цена низкая ($${lastPrice.toFixed(4)}), order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%) - сигнал подтверждается`,
        changePercent,
      };
    }
    
    // ВАЖНО: Если цена очень низкая (< $0.3) и падает значительно (> 10%) - стабильно,
    // даже если imbalance отрицательный (больше покупателей), т.к. падение цены - главный индикатор
    if (lastPrice < 0.3 && changePercent < -10) {
      return {
        stable: true,
        reason: `Цена низкая ($${lastPrice.toFixed(4)}) и падает на ${Math.abs(changePercent).toFixed(2)}% - сигнал подтверждается`,
        changePercent,
      };
    }
    
    // ВАЖНО: Если цена очень низкая (< $0.15) и остается низкой - стабильно,
    // даже если был небольшой рост (процентные изменения на низких ценах обманчивы)
    // Это должно быть ПЕРЕД проверкой на рост > 2%, чтобы избежать ложных срабатываний
    if (lastPrice < 0.15 && firstPrice < 0.15) {
      // Если и первая, и последняя цена очень низкие - это стабильно (цена остается в очень низком диапазоне)
      return {
        stable: true,
        reason: `Цена очень низкая ($${lastPrice.toFixed(4)}) и остается в низком диапазоне - сигнал подтверждается`,
        changePercent,
      };
    }
    
    // ВАЖНО: Если цена низкая (< $0.3) - стабильно, даже если был большой процентный рост
    // (процентные изменения на низких ценах обманчивы, главное - абсолютное значение цены)
    // Это должно быть ПЕРЕД проверкой на процентный рост, чтобы избежать ложных срабатываний
    if (lastPrice < 0.3) {
      return {
        stable: true,
        reason: `Цена низкая ($${lastPrice.toFixed(4)}) - сигнал подтверждается (процентные изменения на низких ценах не критичны)`,
        changePercent,
      };
    }
    
    // Если цена растет более чем на 10% - сигнал отменяется (только для цен > $0.3)
    // Для низких цен (< $0.3) эта проверка не применяется, т.к. процентные изменения обманчивы
    if (changePercent > 10 && lastPrice > 0.3) {
      return {
        stable: false,
        reason: `Цена выросла на ${changePercent.toFixed(2)}% - сигнал отменяется`,
        changePercent,
      };
    }
    
    // Если цена растет на 2-10% - возможна отмена (только для цен > $0.3, чтобы избежать ложных срабатываний на низких ценах)
    if (changePercent > 2 && lastPrice > 0.3) {
      return {
        stable: false,
        reason: `Цена выросла на ${changePercent.toFixed(2)}% - возможна отмена`,
        changePercent,
      };
    }
    
    // Для ОБОИХ сигналов: низкая цена = хорошо, высокая = плохо (рост = отмена)
    // Если цена очень низкая и стабильна, и order book подтверждает - стабильно
    if (isVeryLowPrice && isPriceStable && orderBookOk) {
      return {
        stable: true,
        reason: `Цена стабильна на низком уровне ($${lastPrice.toFixed(4)}), order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
        changePercent,
      };
    }
    
    // Если цена падает и order book подтверждает - стабильно
    if (changePercent < -1 && trendOk && orderBookOk) {
      return {
        stable: true,
        reason: `Цена упала на ${Math.abs(changePercent).toFixed(2)}%, order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
        changePercent,
      };
    }
    
    // Если цена падает значительно (> 10%) и order book подтверждает (больше продавцов) - стабильно
    if (changePercent < -10 && orderBookImbalance > 0.05) {
      return {
        stable: true,
        reason: `Цена упала на ${Math.abs(changePercent).toFixed(2)}%, order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
        changePercent,
      };
    }
    
    // Если цена падает умеренно (> 5%) и order book сильно подтверждает (больше продавцов) - стабильно
    if (changePercent < -5 && orderBookImbalance > 0.10) {
      return {
        stable: true,
        reason: `Цена упала на ${Math.abs(changePercent).toFixed(2)}%, order book сильно подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
        changePercent,
      };
    }
    
    // Если цена стабильна и order book сильно подтверждает (> 80% imbalance в пользу продавцов) - стабильно
    if (isPriceStable && orderBookImbalance > 0.8) {
      return {
        stable: true,
        reason: `Цена стабильна (изменение ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%), order book сильно подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
        changePercent,
      };
    }
    
    // Если цена стабильна и order book подтверждает (> 50% imbalance в пользу продавцов) - стабильно
    if (isPriceStable && orderBookOk) {
      return {
        stable: true,
        reason: `Цена стабильна (изменение ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%), order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
        changePercent,
      };
    }
    
    return {
      stable: false,
      reason: `Нестабильно: изменение ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%, order book imbalance: ${(orderBookImbalance * 100).toFixed(1)}%`,
      changePercent,
    };
  }
  
  /**
   * Проверяет соответствует ли цена сигналу (старая простая логика, оставлена для совместимости)
   */
  checkPriceMatchesSignal(price, signalColor) {
    // Сигнал RED → проверяем цену UP
    // Если price <= 0.5 → сигнал подтверждается (RED)
    // Если price > 0.5 → сигнал отменился (GREEN)
    
    // Сигнал GREEN → проверяем цену DOWN
    // Если price <= 0.5 → сигнал подтверждается (GREEN)
    // Если price > 0.5 → сигнал отменился (RED)
    
    return price <= 0.5;
  }
  
  /**
   * Выполняет проверку цены для валидации (использует логику из monitor-signal-cancel.js)
   */
  async performValidationCheck(series, marketSlug) {
    const asset = series.asset.toUpperCase();
    const polymarket = require('./polymarket');
    
    // Определяем какую цену проверяем
    // Для RED сигнала (ставим на GREEN) проверяем цену UP (зеленую) - подтверждается ли сигнал?
    // Для GREEN сигнала (ставим на RED) проверяем цену DOWN (красную) - подтверждается ли сигнал?
    const checkOutcome = series.signalColor === 'red' ? 'up' : 'down';
    const polySlug = this.convertToPolymarketSlug(marketSlug);
    
    let price = null;
    let tokenId = null;
    let orderBookAnalysis = null;
    
    try {
      const priceData = await polymarket.getBuyPrice(polySlug, checkOutcome);
      if (priceData && priceData.price) {
        price = priceData.price;
        tokenId = priceData.tokenId;
      }
    } catch (error) {
      console.error(`[TRADE] [${this.botId}] Error getting price for validation:`, error.message);
      return;
    }
    
    if (!price) {
      return;
    }
    
    // Получаем order book данные
    if (tokenId) {
      try {
        const orderBookData = await polymarket.getOrderBookDetails(tokenId);
        if (orderBookData && orderBookData.bids && orderBookData.asks) {
          orderBookAnalysis = this.analyzeOrderBook(orderBookData.bids, orderBookData.asks);
        }
      } catch (error) {
        // Order book может быть недоступен, это не критично
        console.warn(`[TRADE] [${this.botId}] Could not get order book for validation:`, error.message);
      }
    }
    
    // Добавляем в историю (с order book данными)
    const historyRecord = {
      timestamp: new Date(),
      price,
      orderBook: orderBookAnalysis,
    };
    
    // Создаем историю для checkStability (нужны записи с price и orderBook)
    const historyForStability = series.validationHistory.map(h => ({
      price: h.price,
      orderBook: h.orderBook,
    }));
    historyForStability.push(historyRecord);
    
    // Используем checkStability для определения стабильности
    // Передаем signalColor, так как checkStability использует его для определения логики проверки
    // Для GREEN сигнала проверяем стабильность цены DOWN (ставим на RED)
    // Для RED сигнала проверяем стабильность цены UP (ставим на GREEN)
    const stabilityResult = this.checkStability(historyForStability, series.signalColor);
    const matches = stabilityResult.stable;
    const symbol = matches ? '+' : '-';
    
    // Добавляем в историю валидации (сохраняем только нужные поля order book)
    series.validationHistory.push({
      timestamp: historyRecord.timestamp,
      price: historyRecord.price,
      matches,
      symbol,
      checkOutcome, // Сохраняем какой исход проверяем (up/down)
      orderBook: orderBookAnalysis ? {
        imbalance: orderBookAnalysis.imbalance,
        bidsTotal: orderBookAnalysis.bidsTotal,
        asksTotal: orderBookAnalysis.asksTotal,
      } : null,
    });
    
    // Ограничиваем историю (храним последние 50 записей)
    if (series.validationHistory.length > 50) {
      series.validationHistory = series.validationHistory.slice(-50);
    }
    
    // Обновляем время последней проверки
    series.lastValidationCheck = new Date();
    
    // Формируем детальное сообщение для визуализации
    const symbols = series.validationHistory.map(h => h.symbol).join('');
    const displaySymbols = symbols.slice(-20); // Последние 20 символов
    
    // Вычисляем изменение цены
    let priceChangeText = '';
    if (series.validationHistory.length >= 2) {
      const firstPrice = series.validationHistory[0].price;
      const lastPrice = price;
      const change = lastPrice - firstPrice;
      const changePercent = firstPrice > 0 ? (change / firstPrice) * 100 : 0;
      priceChangeText = changePercent >= 0 
        ? `+${changePercent.toFixed(1)}%` 
        : `${changePercent.toFixed(1)}%`;
    }
    
    // Информация об order book
    let orderBookText = '';
    if (orderBookAnalysis) {
      const imbalancePercent = (orderBookAnalysis.imbalance * 100).toFixed(1);
      orderBookText = ` | OB: ${imbalancePercent >= 0 ? '+' : ''}${imbalancePercent}%`;
    }
    
    // Статус стабильности
    const stabilityEmoji = stabilityResult.stable ? '✅' : '⚠️';
    
    // Обновляем событие по индексу
    if (series.validationEventIndex !== undefined && series.validationEventIndex >= 0 && series.validationEventIndex < series.events.length) {
      const signalStatus = stabilityResult.stable ? 'Сигнал надежный' : 'Сигнал ненадежный';
      const signalEmoji = series.signalColor === 'red' ? '🔴' : '🟢';
      const message = `Проверяю сигнал "${signalEmoji}": ${displaySymbols} | Цена: $${price.toFixed(3)}${priceChangeText ? ` (${priceChangeText})` : ''}${orderBookText} | ${stabilityEmoji} ${signalStatus}`;
      series.events[series.validationEventIndex].message = message;
    }
    
    // Сохраняем последний результат стабильности для использования в completeValidation
    series.lastStabilityResult = {
      stable: stabilityResult.stable,
      reason: stabilityResult.reason,
      changePercent: stabilityResult.changePercent,
    };
    
    await series.save();
    
    const stabilityInfo = stabilityResult.stable 
      ? `✅ стабильно: ${stabilityResult.reason}`
      : `⚠️ нестабильно: ${stabilityResult.reason}`;
    console.log(`[TRADE] [${this.botId}] ${asset}: Validation check: price $${price.toFixed(3)} → ${symbol} (${series.validationHistory.length} checks) - ${stabilityInfo}`);
  }
  
  /**
   * Завершает валидацию (покупает или отменяет)
   */
  async completeValidation(series, success, stabilityResult = null) {
    const asset = series.asset.toUpperCase();
    
    // Используем переданный stabilityResult или последний сохраненный
    const finalStabilityResult = stabilityResult || series.lastStabilityResult || { stable: success, reason: success ? 'Рынок стабилен' : 'Рынок нестабилен' };
    
    if (success) {
      // Валидация успешна - покупаем
      series.validationState = 'validated';
      
      // Формируем финальное сообщение с причиной решения
      const symbols = series.validationHistory.map(h => h.symbol).join('');
      const displaySymbols = symbols.slice(-20);
      
      // Вычисляем изменение цены для финального сообщения
      let priceChangeInfo = '';
      // Всегда определяем checkOutcome на основе текущей логики, а не из истории (которая может содержать старые данные)
      // Для RED сигнала проверяем цену UP, для GREEN сигнала проверяем цену DOWN
      const checkOutcome = series.signalColor === 'red' ? 'UP' : 'DOWN';
      
      if (series.validationHistory.length >= 2) {
        const firstPrice = series.validationHistory[0].price;
        const lastPrice = series.validationHistory[series.validationHistory.length - 1].price;
        const change = lastPrice - firstPrice;
        const changePercent = firstPrice > 0 ? (change / firstPrice) * 100 : 0;
        priceChangeInfo = ` (Цена ${checkOutcome}: $${firstPrice.toFixed(3)} → $${lastPrice.toFixed(3)}, ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`;
      }
      
      // Обновляем событие с причиной решения
      if (series.validationEventIndex !== undefined && series.validationEventIndex >= 0 && series.validationEventIndex < series.events.length) {
        const reasonText = finalStabilityResult.reason || 'Рынок стабилен';
        // Заменяем "Цена" на "Цена UP" или "Цена DOWN" в reason, если там просто "Цена"
        let enhancedReason = reasonText;
        if (reasonText.includes('Цена упала') || reasonText.includes('Цена выросла') || reasonText.includes('Цена стабильна') || reasonText.includes('Цена низкая') || reasonText.includes('Цена очень низкая')) {
          enhancedReason = reasonText.replace(/Цена/g, `Цена ${checkOutcome}`);
        }
        const signalEmoji = series.signalColor === 'red' ? '🔴' : '🟢';
        series.events[series.validationEventIndex].message = `Проверяю сигнал "${signalEmoji}": ${displaySymbols} Покупка: ${enhancedReason}${priceChangeInfo}`;
      }
      
      await series.save();
      
      // Покупаем
      const bought = await this.buyStep(series);
      if (!bought) {
        // Не удалось купить - отменяем серию
        series.status = 'cancelled';
        series.endedAt = new Date();
        series.addEvent('series_cancelled', {
          message: '⛔ Серия отменена: не удалось купить после валидации',
        });
        await series.save();
        this.activeSeries.delete(series.asset);
        return;
      }
      
      await series.save();
      console.log(`[TRADE] [${this.botId}] ${asset}: Validation successful, bought Step 1`);
      await this.notifyUsers(series, '✅ Валидация пройдена, покупка выполнена');
    } else {
      // Валидация не пройдена - отменяем серию
      series.validationState = 'rejected';
      
      // Формируем финальное сообщение с причиной отказа
      const symbols = series.validationHistory.map(h => h.symbol).join('');
      const displaySymbols = symbols.slice(-20);
      
      // Вычисляем изменение цены для финального сообщения
      let priceChangeInfo = '';
      // Всегда определяем checkOutcome на основе текущей логики, а не из истории (которая может содержать старые данные)
      // Для RED сигнала проверяем цену UP, для GREEN сигнала проверяем цену DOWN
      const checkOutcome = series.signalColor === 'red' ? 'UP' : 'DOWN';
      
      if (series.validationHistory.length >= 2) {
        const firstPrice = series.validationHistory[0].price;
        const lastPrice = series.validationHistory[series.validationHistory.length - 1].price;
        const change = lastPrice - firstPrice;
        const changePercent = firstPrice > 0 ? (change / firstPrice) * 100 : 0;
        priceChangeInfo = ` (Цена ${checkOutcome}: $${firstPrice.toFixed(3)} → $${lastPrice.toFixed(3)}, ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`;
      }
      
      // Обновляем событие с причиной отказа
      if (series.validationEventIndex !== undefined && series.validationEventIndex >= 0 && series.validationEventIndex < series.events.length) {
        const reasonText = finalStabilityResult.reason || 'Рынок нестабилен';
        // Заменяем "Цена" на "Цена UP" или "Цена DOWN" в reason, если там просто "Цена"
        let enhancedReason = reasonText;
        if (reasonText.includes('Цена упала') || reasonText.includes('Цена выросла') || reasonText.includes('Цена стабильна') || reasonText.includes('Цена низкая') || reasonText.includes('Цена очень низкая')) {
          enhancedReason = reasonText.replace(/Цена/g, `Цена ${checkOutcome}`);
        }
        const signalEmoji = series.signalColor === 'red' ? '🔴' : '🟢';
        series.events[series.validationEventIndex].message = `Проверяю сигнал "${signalEmoji}": ${displaySymbols} Отменено: ${enhancedReason}${priceChangeInfo}`;
      }
      
      series.addEvent('validation_rejected', {
        message: `Валидация не пройдена, покупка отменена. Причина: ${finalStabilityResult.reason || 'Рынок нестабилен'}`,
      });
      
      series.status = 'cancelled';
      series.endedAt = new Date();
      
      await series.save();
      this.activeSeries.delete(series.asset);
      
      console.log(`[TRADE] [${this.botId}] ${asset}: Validation failed, series cancelled`);
      await this.notifyUsers(series, '❌ Валидация не пройдена, серия отменена');
    }
  }
  
  /**
   * Валидация рынка (основная функция)
   */
  async validateMarket(series) {
    const asset = series.asset.toUpperCase();
    
    // Получаем контекст для рынка валидации (рынок где сигнал)
    const isBinance = config.dataSource === 'binance';
    const context = isBinance 
      ? await this.dataProvider.get15mContext(series.asset)
      : await this.dataProvider.get15mContext(config.polymarket.markets[series.asset]);
    
    // Находим рынок валидации в контексте
    const validationSlug = series.validationMarketSlug; // Рынок где сигнал
    const getTimestamp = (slug) => parseInt(slug.split('-').pop());
    const validationTimestamp = getTimestamp(validationSlug);
    
    // Определяем какой это рынок (current, prev1, etc.)
    const currentTimestamp = getTimestamp(context.slugs.current);
    const prev1Timestamp = getTimestamp(context.slugs.prev1);
    
    let timeToEnd = null;
    
    if (validationTimestamp === currentTimestamp) {
      // Валидируем текущий рынок (где сигнал)
      timeToEnd = context.current.timeToEnd;
    } else if (validationTimestamp === prev1Timestamp) {
      // Рынок уже закрылся - валидация не нужна
      console.log(`[TRADE] [${this.botId}] ${asset}: Validation market ${validationSlug} already closed`);
      // Отменяем валидацию, не покупаем
      await this.completeValidation(series, false);
      return;
    } else {
      // Рынок еще не наступил или потеряли его
      console.log(`[TRADE] [${this.botId}] ${asset}: Validation market ${validationSlug} not found in context`);
      return;
    }
    
    // Проверка интервала (каждые 10 сек для более частого обновления)
    const now = new Date();
    if (series.lastValidationCheck === null) {
      // Первая проверка
      await this.performValidationCheck(series, validationSlug);
    } else {
      const timeSinceLastCheck = now - series.lastValidationCheck;
      if (timeSinceLastCheck >= 10000) { // 10 секунд
        await this.performValidationCheck(series, validationSlug);
      }
    }
    
    // Используем уже вычисленный результат стабильности из performValidationCheck
    // Если проверка еще не выполнялась, используем дефолтное значение
    const stabilityResult = series.lastStabilityResult || { stable: false, reason: 'Проверка еще не выполнена' };
    
    // Проверяем, что последние 12 записей были стабильными (символ '+')
    // Это гарантирует, что рынок был стабилен в течение 2 минут (12 записей × 10 сек = 120 сек)
    let last12Stable = false;
    if (series.validationHistory.length >= 12) {
      const last12 = series.validationHistory.slice(-12);
      const stableCount = last12.filter(h => h.matches === true).length;
      // Требуем все 12 записей стабильными (100%) - полные 2 минуты стабильности
      last12Stable = stableCount === 12;
    }
    
    // Проверка: за 1 минуту до конца принимаем решение
    if (timeToEnd !== null && timeToEnd <= 60) {
      // Принимаем решение на основе checkStability И проверки стабильности последних 12 записей
      // checkStability требует минимум 12 записей для правильной оценки
      if (stabilityResult.stable && series.validationHistory.length >= 12 && last12Stable) {
        // Рынок стабилен - покупаем
        await this.completeValidation(series, true, stabilityResult);
      } else {
        // Рынок нестабилен - не покупаем, отменяем серию
        // Если checkStability вернул stable=true, но не все 12 записей стабильны, формируем правильный reason
        let finalStabilityResult = stabilityResult;
        if (stabilityResult.stable && !last12Stable && series.validationHistory.length >= 12) {
          const last12 = series.validationHistory.slice(-12);
          const stableCount = last12.filter(h => h.matches === true).length;
          finalStabilityResult = {
            stable: false,
            reason: `Не все записи стабильны: ${stableCount} из 12 (требуется все 12 для 2 минут стабильности)`,
            changePercent: stabilityResult.changePercent,
          };
        }
        // Если checkStability вернул stable=false, используем его reason как есть (например, "сигнал отменяется")
        await this.completeValidation(series, false, finalStabilityResult);
      }
      return;
    }
    
    // Проверка условий покупки: если рынок стабилен (по checkStability) и есть достаточно данных
    // checkStability требует минимум 12 записей (2 минуты при интервале 10 сек) для правильной оценки
    // Также проверяем, что последние 12 записей были стабильными
    if (series.validationHistory.length >= 12 && stabilityResult.stable && last12Stable) {
      // Рынок стабилен в течение 2 минут - покупаем
      await this.completeValidation(series, true, stabilityResult);
    } else if (series.validationHistory.length >= 12 && stabilityResult.stable && !last12Stable) {
      // checkStability вернул stable=true, но не все 12 записей стабильны - формируем правильный reason
      const last12 = series.validationHistory.slice(-12);
      const stableCount = last12.filter(h => h.matches === true).length;
      const finalStabilityResult = {
        stable: false,
        reason: `Не все записи стабильны: ${stableCount} из 12 (требуется все 12 для 2 минут стабильности)`,
        changePercent: stabilityResult.changePercent,
      };
      await this.completeValidation(series, false, finalStabilityResult);
    } else if (series.validationHistory.length >= 12 && !stabilityResult.stable) {
      // checkStability вернул stable=false - используем его reason как есть (например, "сигнал отменяется")
      await this.completeValidation(series, false, stabilityResult);
    }
  }

  // ==================== ВАЛИДАЦИЯ ХЕДЖА ====================
  
  /**
   * Начинает валидацию хеджа для следующего шага
   */
  async startHedgeValidation(series, context) {
    const asset = series.asset.toUpperCase();
    const nextMarketSlug = context.slugs.next;
    const nextStep = series.currentStep + 1;
    
    // Проверяем, что следующий шаг не превышает maxSteps
    if (nextStep > this.config.maxSteps) {
      return; // Не валидируем если шаг превышает maxSteps
    }
    
    // Начинаем валидацию хеджа
    series.hedgeValidationState = 'validating';
    // Валидируем текущий рынок (где мы проиграли), чтобы понять нужно ли покупать следующий шаг
    series.hedgeValidationMarketSlug = context.slugs.current;
    series.hedgeValidationHistory = [];
    series.hedgeLastValidationCheck = null;
    
    // Добавляем событие валидации хеджа
    const signalEmoji = series.signalColor === 'red' ? '🔴' : '🟢';
    series.addEvent('validation_started', {
      message: `Проверяю сигнал "${signalEmoji}":`,
    });
    // Сохраняем индекс последнего события
    series.hedgeValidationEventIndex = series.events.length - 1;
    
    await series.save();
    
    console.log(`[TRADE] [${this.botId}] ${asset}: Started hedge validation for Step ${nextStep} on market ${nextMarketSlug}`);
  }
  
  /**
   * Выполняет проверку цены для валидации хеджа (использует логику из monitor-signal-cancel.js)
   */
  async performHedgeValidationCheck(series, marketSlug) {
    const asset = series.asset.toUpperCase();
    const polymarket = require('./polymarket');
    const nextStep = series.currentStep + 1;
    
    // Определяем какую цену проверяем
    // Для хеджа логика такая же как для первой валидации:
    // - Если исходный сигнал был RED (ставим на GREEN) → проверяем цену UP (зеленую) - подтверждается ли сигнал?
    // - Если исходный сигнал был GREEN (ставим на RED) → проверяем цену DOWN (красную) - подтверждается ли сигнал?
    const checkOutcome = series.signalColor === 'red' ? 'up' : 'down';
    const polySlug = this.convertToPolymarketSlug(marketSlug);
    
    let price = null;
    let tokenId = null;
    let orderBookAnalysis = null;
    
    try {
      const priceData = await polymarket.getBuyPrice(polySlug, checkOutcome);
      if (priceData && priceData.price) {
        price = priceData.price;
        tokenId = priceData.tokenId;
      }
    } catch (error) {
      console.error(`[TRADE] [${this.botId}] Error getting price for hedge validation:`, error.message);
      return;
    }
    
    if (!price) {
      return;
    }
    
    // Получаем order book данные
    if (tokenId) {
      try {
        const orderBookData = await polymarket.getOrderBookDetails(tokenId);
        if (orderBookData && orderBookData.bids && orderBookData.asks) {
          orderBookAnalysis = this.analyzeOrderBook(orderBookData.bids, orderBookData.asks);
        }
      } catch (error) {
        // Order book может быть недоступен, это не критично
        console.warn(`[TRADE] [${this.botId}] Could not get order book for hedge validation:`, error.message);
      }
    }
    
    // Добавляем в историю (с order book данными)
    const historyRecord = {
      timestamp: new Date(),
      price,
      orderBook: orderBookAnalysis,
    };
    
    // Создаем историю для checkStability (нужны записи с price и orderBook)
    const historyForStability = series.hedgeValidationHistory.map(h => ({
      price: h.price,
      orderBook: h.orderBook,
    }));
    historyForStability.push(historyRecord);
    
    // Используем checkStability для определения стабильности
    // Для хеджа логика такая же как для первой валидации (используем исходный signalColor):
    // - Если исходный сигнал был GREEN → проверяем стабильность GREEN (передаем 'green')
    // - Если исходный сигнал был RED → проверяем стабильность RED (передаем 'red')
    const stabilityResult = this.checkStability(historyForStability, series.signalColor);
    const matches = stabilityResult.stable;
    const symbol = matches ? '+' : '-';
    
    // Добавляем в историю валидации
    series.hedgeValidationHistory.push({
      timestamp: historyRecord.timestamp,
      price: historyRecord.price,
      matches,
      symbol,
      checkOutcome, // Сохраняем какой исход проверяем (up/down)
      orderBook: orderBookAnalysis ? {
        imbalance: orderBookAnalysis.imbalance,
        bidsTotal: orderBookAnalysis.bidsTotal,
        asksTotal: orderBookAnalysis.asksTotal,
      } : null,
    });
    
    // Ограничиваем историю (храним последние 50 записей)
    if (series.hedgeValidationHistory.length > 50) {
      series.hedgeValidationHistory = series.hedgeValidationHistory.slice(-50);
    }
    
    // Обновляем время последней проверки
    series.hedgeLastValidationCheck = new Date();
    
    // Формируем детальное сообщение для визуализации
    const symbols = series.hedgeValidationHistory.map(h => h.symbol).join('');
    const displaySymbols = symbols.slice(-20); // Последние 20 символов
    
    // Вычисляем изменение цены
    let priceChangeText = '';
    if (series.hedgeValidationHistory.length >= 2) {
      const firstPrice = series.hedgeValidationHistory[0].price;
      const lastPrice = price;
      const change = lastPrice - firstPrice;
      const changePercent = firstPrice > 0 ? (change / firstPrice) * 100 : 0;
      priceChangeText = changePercent >= 0 
        ? `+${changePercent.toFixed(1)}%` 
        : `${changePercent.toFixed(1)}%`;
    }
    
    // Информация об order book
    let orderBookText = '';
    if (orderBookAnalysis) {
      const imbalancePercent = (orderBookAnalysis.imbalance * 100).toFixed(1);
      orderBookText = ` | OB: ${imbalancePercent >= 0 ? '+' : ''}${imbalancePercent}%`;
    }
    
    // Статус стабильности
    const stabilityEmoji = stabilityResult.stable ? '✅' : '⚠️';
    
    // Обновляем событие по индексу
    if (series.hedgeValidationEventIndex !== undefined && series.hedgeValidationEventIndex >= 0 && series.hedgeValidationEventIndex < series.events.length) {
      const signalStatus = stabilityResult.stable ? 'Сигнал надежный' : 'Сигнал ненадежный';
      const signalEmoji = series.signalColor === 'red' ? '🔴' : '🟢';
      const message = `Проверяю сигнал "${signalEmoji}": ${displaySymbols} | Цена: $${price.toFixed(3)}${priceChangeText ? ` (${priceChangeText})` : ''}${orderBookText} | ${stabilityEmoji} ${signalStatus}`;
      series.events[series.hedgeValidationEventIndex].message = message;
    }
    
    // Сохраняем последний результат стабильности для использования в completeHedgeValidation
    series.lastHedgeStabilityResult = {
      stable: stabilityResult.stable,
      reason: stabilityResult.reason,
      changePercent: stabilityResult.changePercent,
    };
    
    await series.save();
    
    const stabilityInfo = stabilityResult.stable 
      ? `✅ стабильно: ${stabilityResult.reason}`
      : `⚠️ нестабильно: ${stabilityResult.reason}`;
    console.log(`[TRADE] [${this.botId}] ${asset}: Hedge validation check: price $${price.toFixed(3)} → ${symbol} (${series.hedgeValidationHistory.length} checks) - ${stabilityInfo}`);
  }
  
  /**
   * Завершает валидацию хеджа (покупает или отменяет)
   */
  async completeHedgeValidation(series, success, context, stabilityResult = null) {
    const asset = series.asset.toUpperCase();
    const nextStep = series.currentStep + 1;
    
    // Используем переданный stabilityResult или последний сохраненный
    const finalStabilityResult = stabilityResult || series.lastHedgeStabilityResult || { stable: success, reason: success ? 'Рынок стабилен' : 'Рынок нестабилен' };
    
    if (success) {
      // Сигнал надежный - покупаем хедж (рынок закроется зеленым)
      series.hedgeValidationState = 'validated';
      
      // Формируем финальное сообщение с причиной решения
      const symbols = series.hedgeValidationHistory.map(h => h.symbol).join('');
      const displaySymbols = symbols.slice(-20);
      
      // Вычисляем изменение цены для финального сообщения
      let priceChangeInfo = '';
      // Всегда определяем checkOutcome на основе текущей логики, а не из истории (которая может содержать старые данные)
      // Для RED сигнала проверяем цену UP, для GREEN сигнала проверяем цену DOWN
      const checkOutcome = series.signalColor === 'red' ? 'UP' : 'DOWN';
      
      if (series.hedgeValidationHistory.length >= 2) {
        const firstPrice = series.hedgeValidationHistory[0].price;
        const lastPrice = series.hedgeValidationHistory[series.hedgeValidationHistory.length - 1].price;
        const change = lastPrice - firstPrice;
        const changePercent = firstPrice > 0 ? (change / firstPrice) * 100 : 0;
        priceChangeInfo = ` (Цена ${checkOutcome}: $${firstPrice.toFixed(3)} → $${lastPrice.toFixed(3)}, ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`;
      }
      
      // Обновляем событие с причиной решения
      if (series.hedgeValidationEventIndex !== undefined && series.hedgeValidationEventIndex >= 0 && series.hedgeValidationEventIndex < series.events.length) {
        const reasonText = finalStabilityResult.reason || 'Сигнал надежный';
        // Заменяем "Цена" на "Цена UP" или "Цена DOWN" в reason, если там просто "Цена"
        let enhancedReason = reasonText;
        if (reasonText.includes('Цена упала') || reasonText.includes('Цена выросла') || reasonText.includes('Цена стабильна') || reasonText.includes('Цена низкая') || reasonText.includes('Цена очень низкая')) {
          enhancedReason = reasonText.replace(/Цена/g, `Цена ${checkOutcome}`);
        }
        const signalEmoji = series.signalColor === 'red' ? '🔴' : '🟢';
        series.events[series.hedgeValidationEventIndex].message = `Проверяю сигнал "${signalEmoji}": ${displaySymbols} Сигнал надежный - Покупка хеджа: ${enhancedReason}${priceChangeInfo}`;
      }
      
      await series.save();
      
      // Покупаем хедж
      await this.buyNextStepEarly(series, context);
      
      console.log(`[TRADE] [${this.botId}] ${asset}: Hedge validation: signal stable, bought hedge for Step ${nextStep}`);
    } else {
      // Сигнал ненадежный - не покупаем хедж (рынок закроется красным, мы выиграем)
      series.hedgeValidationState = 'rejected';
      
      // Формируем финальное сообщение с причиной отказа
      const symbols = series.hedgeValidationHistory.map(h => h.symbol).join('');
      const displaySymbols = symbols.slice(-20);
      
      // Вычисляем изменение цены для финального сообщения
      let priceChangeInfo = '';
      // Всегда определяем checkOutcome на основе текущей логики, а не из истории (которая может содержать старые данные)
      // Для RED сигнала проверяем цену UP, для GREEN сигнала проверяем цену DOWN
      const checkOutcome = series.signalColor === 'red' ? 'UP' : 'DOWN';
      
      if (series.hedgeValidationHistory.length >= 2) {
        const firstPrice = series.hedgeValidationHistory[0].price;
        const lastPrice = series.hedgeValidationHistory[series.hedgeValidationHistory.length - 1].price;
        const change = lastPrice - firstPrice;
        const changePercent = firstPrice > 0 ? (change / firstPrice) * 100 : 0;
        priceChangeInfo = ` (Цена ${checkOutcome}: $${firstPrice.toFixed(3)} → $${lastPrice.toFixed(3)}, ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`;
      }
      
      // Обновляем событие с причиной отказа
      if (series.hedgeValidationEventIndex !== undefined && series.hedgeValidationEventIndex >= 0 && series.hedgeValidationEventIndex < series.events.length) {
        const reasonText = finalStabilityResult.reason || 'Сигнал ненадежный';
        // Заменяем "Цена" на "Цена UP" или "Цена DOWN" в reason, если там просто "Цена"
        let enhancedReason = reasonText;
        if (reasonText.includes('Цена упала') || reasonText.includes('Цена выросла') || reasonText.includes('Цена стабильна') || reasonText.includes('Цена низкая') || reasonText.includes('Цена очень низкая')) {
          enhancedReason = reasonText.replace(/Цена/g, `Цена ${checkOutcome}`);
        }
        const signalEmoji = series.signalColor === 'red' ? '🔴' : '🟢';
        series.events[series.hedgeValidationEventIndex].message = `Проверяю сигнал "${signalEmoji}": ${displaySymbols} Сигнал ненадежный - Хедж не нужен: ${enhancedReason}${priceChangeInfo}`;
      }
      
      series.addEvent('validation_rejected', {
        message: `Валидация хеджа Step ${nextStep} не пройдена, хедж не покупаем. Причина: ${finalStabilityResult.reason || 'Рынок нестабилен'}`,
      });
      
      await series.save();
      
      console.log(`[TRADE] [${this.botId}] ${asset}: Hedge validation failed, not buying hedge for Step ${nextStep}`);
    }
  }
  
  /**
   * Валидация хеджа (основная функция)
   */
  async validateHedgeMarket(series, context) {
    const asset = series.asset.toUpperCase();
    
    // Находим рынок валидации (следующий рынок)
    const validationSlug = series.hedgeValidationMarketSlug;
    const getTimestamp = (slug) => parseInt(slug.split('-').pop());
    const validationTimestamp = getTimestamp(validationSlug);
    
    // Определяем какой это рынок
    const currentTimestamp = getTimestamp(context.slugs.current);
    const nextTimestamp = getTimestamp(context.slugs.next);
    
    let timeToEnd = null;
    
    if (validationTimestamp === currentTimestamp) {
      // Валидируем текущий рынок (следующий рынок уже начался)
      timeToEnd = context.current.timeToEnd;
    } else if (validationTimestamp === nextTimestamp) {
      // Валидируем следующий рынок (еще не начался)
      // Время до начала = timeToEnd текущего рынка + 15 минут
      timeToEnd = context.current.timeToEnd + (15 * 60);
    } else {
      // Рынок уже прошел или еще не наступил
      console.log(`[TRADE] [${this.botId}] ${asset}: Hedge validation market ${validationSlug} not found in context`);
      // Отменяем валидацию хеджа
      series.hedgeValidationState = 'rejected';
      await series.save();
      return;
    }
    
    // Проверка интервала (каждые 10 сек для более частого обновления)
    const now = new Date();
    if (series.hedgeLastValidationCheck === null) {
      // Первая проверка
      await this.performHedgeValidationCheck(series, validationSlug);
    } else {
      const timeSinceLastCheck = now - series.hedgeLastValidationCheck;
      if (timeSinceLastCheck >= 10000) { // 10 секунд
        await this.performHedgeValidationCheck(series, validationSlug);
      }
    }
    
    // Используем уже вычисленный результат стабильности из performHedgeValidationCheck
    // Если проверка еще не выполнялась, используем дефолтное значение
    const stabilityResult = series.lastHedgeStabilityResult || { stable: false, reason: 'Проверка еще не выполнена' };
    
    // Проверяем, что последние 12 записей были стабильными (символ '+')
    // Это гарантирует, что рынок был стабилен в течение 2 минут (12 записей × 10 сек = 120 сек)
    let last12Stable = false;
    if (series.hedgeValidationHistory.length >= 12) {
      const last12 = series.hedgeValidationHistory.slice(-12);
      const stableCount = last12.filter(h => h.matches === true).length;
      // Требуем все 12 записей стабильными (100%) - полные 2 минуты стабильности
      last12Stable = stableCount === 12;
    }
    
    // Проверка: за 1 минуту до начала/конца принимаем решение
    if (timeToEnd !== null && timeToEnd <= 60) {
      // Принимаем решение на основе checkStability И проверки стабильности последних 12 записей
      // Если сигнал надежный (stable = true) → покупаем хедж (рынок закроется зеленым, нужна защита)
      // Если сигнал ненадежный (stable = false) → не покупаем хедж (рынок закроется красным, мы выиграем)
      if (stabilityResult.stable && series.hedgeValidationHistory.length >= 12 && last12Stable) {
        // Сигнал надежный - покупаем хедж (рынок закроется зеленым)
        await this.completeHedgeValidation(series, true, context, stabilityResult);
      } else {
        // Сигнал ненадежный - не покупаем хедж (рынок закроется красным, мы выиграем)
        // Если checkStability вернул stable=true, но не все 12 записей стабильны, формируем правильный reason
        let finalStabilityResult = stabilityResult;
        if (stabilityResult.stable && !last12Stable && series.hedgeValidationHistory.length >= 12) {
          const last12 = series.hedgeValidationHistory.slice(-12);
          const stableCount = last12.filter(h => h.matches === true).length;
          finalStabilityResult = {
            stable: false,
            reason: `Не все записи стабильны: ${stableCount} из 12 (требуется все 12 для 2 минут стабильности)`,
            changePercent: stabilityResult.changePercent,
          };
        }
        await this.completeHedgeValidation(series, false, context, finalStabilityResult);
      }
      return;
    }
    
    // Проверка условий покупки: если сигнал надежный (по checkStability) и есть достаточно данных
    // checkStability требует минимум 12 записей (2 минуты при интервале 10 сек) для правильной оценки
    // Также проверяем, что последние 12 записей были стабильными
    if (series.hedgeValidationHistory.length >= 12 && stabilityResult.stable && last12Stable) {
      // Сигнал надежный - покупаем хедж (рынок закроется зеленым)
      await this.completeHedgeValidation(series, true, context, stabilityResult);
    } else if (series.hedgeValidationHistory.length >= 12 && stabilityResult.stable && !last12Stable) {
      // checkStability вернул stable=true, но не все 12 записей стабильны - формируем правильный reason
      const last12 = series.hedgeValidationHistory.slice(-12);
      const stableCount = last12.filter(h => h.matches === true).length;
      const finalStabilityResult = {
        stable: false,
        reason: `Не все записи стабильны: ${stableCount} из 12 (требуется все 12 для 2 минут стабильности)`,
        changePercent: stabilityResult.changePercent,
      };
      await this.completeHedgeValidation(series, false, context, finalStabilityResult);
    } else if (series.hedgeValidationHistory.length >= 12 && !stabilityResult.stable) {
      // checkStability вернул stable=false - используем его reason как есть (например, "сигнал отменяется")
      await this.completeHedgeValidation(series, false, context, stabilityResult);
    }
  }

  // ==================== ОТМЕНА СИГНАЛА ====================
  
  async cancelSignal(series, currentColor) {
    const polymarket = require('./polymarket');
    const asset = series.asset.toUpperCase();
    const colorEmoji = currentColor === 'green' ? '🟢' : '🔴';
    const signalEmoji = series.signalColor === 'green' ? '🟢' : '🔴';
    const betOutcome = series.betColor === 'green' ? 'up' : 'down';
    
    const stats = await TradingStats.getStats(this.botId);
    let totalReturn = 0;
    let totalLoss = 0;
    
    // Продаём все активные позиции по реальной цене
    for (const pos of series.positions) {
      if (pos.status === 'active') {
        // Получаем реальную цену продажи с Polymarket для конкретного рынка позиции
        const polySlug = this.convertToPolymarketSlug(pos.marketSlug || series.currentMarketSlug);
        let sellPrice = null;
        let sellTokenId = null;
        
        try {
          const priceData = await polymarket.getSellPrice(polySlug, betOutcome);
          if (priceData && priceData.price) {
            sellPrice = priceData.price;
            sellTokenId = priceData.tokenId;
            console.log(`[TRADE] [${this.botId}] Got sell price for ${polySlug}: $${sellPrice.toFixed(3)}`);
          }
        } catch (error) {
          console.error(`[TRADE] Error getting sell price for ${polySlug}:`, error.message);
        }
        
        // Если не получили цену - отменяем серию с ошибкой
        if (!sellPrice) {
          console.error(`[TRADE] Cannot get sell price for ${polySlug}, cancelling series`);
          series.addEvent('price_error', {
            message: `❌ Не удалось получить цену продажи для ${polySlug}`,
            slug: polySlug,
          });
          // Продолжаем продавать остальные позиции, но эта позиция останется активной
          continue;
        }
        
        // Расчёт: shares * sellPrice - exitFee
        const grossReturn = pos.shares * sellPrice;
        const exitFee = grossReturn * this.EXIT_FEE_RATE;
        const netReturn = grossReturn - exitFee;
        
        totalReturn += netReturn;
        totalLoss += (pos.amount - netReturn);
        pos.status = 'sold';
        series.totalCommission += exitFee;
        
        // Добавляем событие о продаже позиции с ценой и хешем
        const sellHash = getShortHash(sellTokenId);
        series.addEvent('sell', {
          step: pos.step,
          amount: netReturn,
          message: `📤 Продал Step ${pos.step}: ${pos.shares.toFixed(2)} shares- по $${sellPrice.toFixed(2)} (${sellHash}) = $${netReturn.toFixed(2)}`,
        });
        
        // Если это Step 1, получаем детальную информацию об order book и добавляем отдельное событие
        if (sellTokenId) {
          try {
            const orderBookDetails = await polymarket.getOrderBookDetails(sellTokenId);
            if (orderBookDetails) {
              const bidsTotal = orderBookDetails.bids.reduce((sum, bid) => sum + bid.size, 0);
              const asksTotal = orderBookDetails.asks.reduce((sum, ask) => sum + ask.size, 0);
              const bidsCount = orderBookDetails.bids.length;
              const asksCount = orderBookDetails.asks.length;
              series.addEvent('order_book', {
                step: 1,
                message: `📊 Order Book: Bids ${bidsTotal.toFixed(0)} (${bidsCount} levels) | Asks ${asksTotal.toFixed(0)} (${asksCount} levels)`,
                data: {
                  bids: orderBookDetails.bids,
                  asks: orderBookDetails.asks,
                },
              });
            }
          } catch (error) {
            console.error(`[TRADE] Error getting order book details for Step 1:`, error.message);
          }
        }
        
        console.log(`[TRADE] [${this.botId}] Sold ${pos.shares.toFixed(2)} shares- по $${sellPrice.toFixed(3)} = $${grossReturn.toFixed(2)} - $${exitFee.toFixed(2)} fee = $${netReturn.toFixed(2)}`);
      }
    }
    
    stats.currentBalance += totalReturn;
    stats.cancelledTrades++;
    await stats.save();
    
    // Рассчитываем P&L
    const pnl = totalReturn - series.totalInvested;
    series.totalPnL = pnl;
    series.status = 'cancelled';
    series.endedAt = new Date();
    series.nextStepBought = false;
    series.nextMarketSlug = null;
    
    series.addEvent('signal_cancelled', {
      marketColor: currentColor,
      pnl,
      message: `⚠️ Сигнал отменён: рынок ${colorEmoji} (был ${signalEmoji}) → вернул $${totalReturn.toFixed(2)} (P&L: $${pnl.toFixed(2)})`,
    });
    
    await series.save();
    this.activeSeries.delete(series.asset);
    
    console.log(`[TRADE] [${this.botId}] ${asset}: ⚠️ SIGNAL CANCELLED - returned $${totalReturn.toFixed(2)}, P&L: $${pnl.toFixed(2)}`);
    await this.log(series.asset, series.signalMarketSlug, `SIGNAL CANCELLED: returned $${totalReturn.toFixed(2)}, P&L: $${pnl.toFixed(2)}`, { totalReturn, pnl });
    await this.notifyUsers(series, `⚠️ Сигнал отменён`);
  }

  // ==================== ПРОДАЖА ХЕДЖА ====================
  
  async sellHedge(series, timeToEnd = null) {
    const asset = series.asset.toUpperCase();
    const hedgeStep = series.currentStep + 1;
    const betEmoji = series.betColor === 'green' ? '🟢' : '🔴';
    
    // Находим позицию хеджа
    const hedgePosition = series.positions.find(p => p.step === hedgeStep && p.status === 'active');
    if (!hedgePosition) return;
    
    // Получаем реальную цену продажи с Polymarket
    const polymarket = require('./polymarket');
    const betOutcome = series.betColor === 'green' ? 'up' : 'down';
    const polySlug = this.convertToPolymarketSlug(hedgePosition.marketSlug);
    let sellPrice = null;
    let sellTokenId = null;
    let orderBookDetails = null;
    
    try {
      const priceData = await polymarket.getSellPrice(polySlug, betOutcome);
      if (priceData && priceData.price) {
        sellPrice = priceData.price;
        sellTokenId = priceData.tokenId;
        console.log(`[TRADE] [${this.botId}] Got sell price for hedge ${polySlug}: $${sellPrice.toFixed(3)}`);
        
        // Если это продажа за 20 секунд до конца, получаем детальную информацию об order book
        if (timeToEnd !== null && timeToEnd <= 20 && sellTokenId) {
          try {
            orderBookDetails = await polymarket.getOrderBookDetails(sellTokenId);
            if (orderBookDetails) {
              const bidsTotal = orderBookDetails.bids.reduce((sum, bid) => sum + bid.size, 0);
              const asksTotal = orderBookDetails.asks.reduce((sum, ask) => sum + ask.size, 0);
              console.log(`[TRADE] [${this.botId}] Order book details for hedge: bids: ${bidsTotal.toFixed(2)}, asks: ${asksTotal.toFixed(2)}`);
            }
          } catch (error) {
            console.error(`[TRADE] Error getting order book details:`, error.message);
          }
        }
      }
    } catch (error) {
      console.error(`[TRADE] Error getting sell price for hedge ${polySlug}:`, error.message);
    }
    
    // Если не получили цену - используем упрощённую формулу
    let returnAmount;
    if (sellPrice) {
      // Реальная цена продажи: shares * sellPrice - exitFee
      const grossReturn = hedgePosition.shares * sellPrice;
      const exitFee = grossReturn * this.EXIT_FEE_RATE;
      returnAmount = grossReturn - exitFee;
    } else {
      // Fallback: упрощённая формула
      returnAmount = hedgePosition.amount * (1 - this.EXIT_FEE_RATE * 2);
      console.log(`[TRADE] [${this.botId}] Using fallback sell price for hedge`);
    }
    
    const stats = await TradingStats.getStats(this.botId);
    stats.currentBalance += returnAmount;
    await stats.save();
    
    // Обновляем позицию
    hedgePosition.status = 'sold';
    
    // Корректируем учёт
    series.totalInvested -= hedgePosition.amount;
    series.totalCommission += hedgePosition.amount * this.EXIT_FEE_RATE;
    series.nextStepBought = false;
    series.nextMarketSlug = null;
    
    const loss = hedgePosition.amount - returnAmount;
    
    // Учитываем потерю от продажи хеджа
    series.hedgeLosses = (series.hedgeLosses || 0) + loss;
    
    // Событие: продали хедж
    const sellHash = sellTokenId ? getShortHash(sellTokenId) : '';
    const priceText = sellPrice ? `по $${sellPrice.toFixed(2)} (${sellHash})` : '';
    series.addEvent('sell_hedge', {
      amount: returnAmount,
      step: hedgeStep,
      message: `📤 Продал хедж Step ${hedgeStep}${priceText ? ` ${priceText}` : ''}: вернул $${returnAmount.toFixed(2)} ($${loss.toFixed(2)})`,
    });
    
    // Если есть детальная информация об order book, добавляем отдельное событие
    if (orderBookDetails && timeToEnd !== null && timeToEnd <= 20) {
      const bidsTotal = orderBookDetails.bids.reduce((sum, bid) => sum + bid.size, 0);
      const asksTotal = orderBookDetails.asks.reduce((sum, ask) => sum + ask.size, 0);
      const bidsCount = orderBookDetails.bids.length;
      const asksCount = orderBookDetails.asks.length;
      series.addEvent('order_book', {
        step: hedgeStep,
        message: `📊 Order Book: Bids ${bidsTotal.toFixed(0)} (${bidsCount} levels) | Asks ${asksTotal.toFixed(0)} (${asksCount} levels)`,
        data: {
          bids: orderBookDetails.bids,
          asks: orderBookDetails.asks,
        },
      });
    }
    
    await series.save();
    console.log(`[TRADE] [${this.botId}] ${asset}: 📤 SELL HEDGE - Returned $${returnAmount.toFixed(2)} (Step ${hedgeStep})`);
    await this.log(series.asset, series.currentMarketSlug, `SELL HEDGE Step ${hedgeStep}: returned $${returnAmount.toFixed(2)} ($${loss.toFixed(2)})`, { step: hedgeStep, returnAmount, loss });
    await this.notifyUsers(series, `📤 Продал хедж`);
  }

  // ==================== ПРОВЕРКА КАЖДЫЕ 5 СЕК ====================
  
  async tick() {
    // Проверяем и завершаем истекшие cooldown серии
    const now = new Date();
    for (const [type, series] of this.activeSeries) {
      if (series.status === 'cooldown' && series.endedAt && new Date(series.endedAt) <= now) {
        try {
          await this.endCooldown(series);
          this.activeSeries.delete(type);
        } catch (error) {
          console.error(`[TRADE] Error ending cooldown for ${type}:`, error.message);
        }
      }
    }
    
    // Проверяем обычные серии
    for (const [type, series] of this.activeSeries) {
      if (series.status === 'cooldown') continue; // Пропускаем cooldown серии
      try {
        await this.checkSeries(series);
      } catch (error) {
        console.error(`[TRADE] Error checking ${type}:`, error.message);
      }
    }
  }

  async checkSeries(series) {
    // Проверка валидации (если серия в процессе валидации)
    if (series.validationState === 'validating') {
      await this.validateMarket(series);
      return; // Выходим, не продолжаем обычную логику
    }
    
    const isBinance = config.dataSource === 'binance';
    const context = isBinance 
      ? await this.dataProvider.get15mContext(series.asset)
      : await this.dataProvider.get15mContext(config.polymarket.markets[series.asset]);
    
    // Проверка валидации хеджа (если серия в процессе валидации хеджа)
    // НЕ выходим, продолжаем обычную логику (валидация хеджа не блокирует серию)
    if (series.hedgeValidationState === 'validating') {
      await this.validateHedgeMarket(series, context);
    }

    const getTimestamp = (slug) => parseInt(slug.split('-').pop());
    
    const ourTimestamp = getTimestamp(series.currentMarketSlug);
    const currentTimestamp = getTimestamp(context.slugs.current);
    const prev1Timestamp = getTimestamp(context.slugs.prev1);
    
    const asset = series.asset.toUpperCase();
    const currentColor = context.current.color;
    const colorEmoji = currentColor === 'green' ? '🟢' : '🔴';

    // ПРОВЕРКА ОТМЕНЫ СИГНАЛА: если рынок где был сигнал ещё активен и цвет изменился
    if (series.signalMarketSlug && series.currentStep === 1) {
      const signalTimestamp = getTimestamp(series.signalMarketSlug);
      
      // Сигнальный рынок ещё активен
      if (signalTimestamp === currentTimestamp) {
        const timeToEnd = context.current.timeToEnd;
        
        // За 20 сек до конца, если цвет изменился → сигнал отменился
        if (timeToEnd <= 20 && currentColor !== series.signalColor) {
          await this.cancelSignal(series, currentColor);
          return;
        }
      }
    }

    // 1. Наш рынок ещё не начался
    if (ourTimestamp > currentTimestamp) {
      if (series.marketState !== 'waiting') {
        series.marketState = 'waiting';
        await series.save();
      }
      if (config.debug) {
        console.log(`[TRADE] [${this.botId}] ${asset} Step ${series.currentStep}: ⏳ Waiting for market...`);
      }
      return;
    }

    // 2. Наш рынок сейчас активен
    if (ourTimestamp === currentTimestamp) {
      // Обновляем состояние если было waiting
      if (series.marketState === 'waiting') {
        series.marketState = 'active';
        series.addEvent('market_active', {
          message: `Рынок активен`,
        });
        await series.save();
        console.log(`[TRADE] [${this.botId}] ${asset} Step ${series.currentStep}: 📊 Market is now active`);
      }
      
      // РАННЯЯ ПОКУПКА: если рынок идёт против нас (цвет = signalColor), покупаем следующий шаг заранее
      if (!series.nextStepBought && series.currentStep < this.config.maxSteps && currentColor === series.signalColor) {
        if (this.config.buyStrategy === 'signal') {
          // Покупаем хедж сразу
          await this.buyNextStepEarly(series, context);
        } else if (this.config.buyStrategy === 'validate') {
          // Начинаем валидацию хеджа
          if (!series.hedgeValidationState || series.hedgeValidationState === null) {
            await this.startHedgeValidation(series, context);
          }
        }
      }
      
      // ПРОДАЖА ХЕДЖА: за 20 сек до конца, если рынок наш цвет — продаём хедж
      const timeToEnd = context.current.timeToEnd;
      if (series.nextStepBought && currentColor === series.betColor && timeToEnd <= 20) {
        await this.sellHedge(series, timeToEnd);
      }
      
      if (config.debug) {
        const hedgeInfo = series.nextStepBought ? ' [HEDGED]' : '';
        console.log(`[TRADE] [${this.botId}] ${asset} Step ${series.currentStep}: ${colorEmoji} ${currentColor} | ${timeToEnd}s left${hedgeInfo}`);
      }
      return;
    }

    // 3. Наш рынок закрылся (стал prev1)
    if (ourTimestamp === prev1Timestamp) {
      const resolvedColor = context.previous[1].color;
      
      if (resolvedColor === 'unknown') {
        console.log(`[TRADE] [${this.botId}] ${asset}: Market closed but color unknown, waiting...`);
        return;
      }
      
      await this.resolveMarket(series, resolvedColor, context);
      return;
    }

    // 4. Потеряли рынок
    console.log(`[TRADE] [${this.botId}] ${asset}: WARNING - Lost track of market`);
  }

  // ==================== РЕЗОЛВ РЫНКА ====================
  
  async resolveMarket(series, resolvedColor, context) {
    const asset = series.asset.toUpperCase();
    const won = resolvedColor === series.betColor;
    const colorEmoji = resolvedColor === 'green' ? '🟢' : '🔴';
    
    series.marketState = 'closed';
    
    if (won) {
      // Если хедж был куплен, продаём его при выигрыше (даже если рынок закрылся раньше проверки за 20 сек)
      if (series.nextStepBought) {
        console.log(`[TRADE] [${this.botId}] ${asset}: Market won, selling hedge before calculating P&L...`);
        await this.sellHedge(series, null); // null = не за 20 секунд до конца
      } else {
        // Хедж не был куплен - сбрасываем состояние валидации хеджа (если была)
        if (series.hedgeValidationState === 'rejected' || series.hedgeValidationState === 'validating') {
          series.hedgeValidationState = null;
          series.hedgeValidationHistory = [];
          series.hedgeValidationEventIndex = null;
          series.hedgeValidationMarketSlug = null;
          series.hedgeLastValidationCheck = null;
        }
      }
      
      // ПРОФИТ! Получаем shares (каждая = $1)
      const currentPosition = series.positions.find(p => p.step === series.currentStep && p.status === 'active');
      const shares = currentPosition?.shares || 0;
      
      // Рассчитываем выигрыш с учетом комиссии на выход
      const grossReturn = shares * 1.0; // shares * $1
      const exitFee = grossReturn * this.EXIT_FEE_RATE;
      const winAmount = grossReturn - exitFee;
      
      // Обновляем статус позиции
      if (currentPosition) currentPosition.status = 'won';
      
      // Учитываем комиссию на выход в общей комиссии
      series.totalCommission += exitFee;
      
      // P&L = выигрыш - вложено - потери на хеджах
      const hedgeLosses = series.hedgeLosses || 0;
      const pnl = winAmount - series.totalInvested - hedgeLosses;
      
      series.addEvent('market_won', {
        marketColor: resolvedColor,
        pnl: winAmount - currentPosition?.amount,
        message: `Рынок закрылся ${colorEmoji} — ПРОФИТ! Получил $${winAmount.toFixed(2)} (+$${(winAmount - currentPosition?.amount).toFixed(2)})`,
      });
      
      series.totalPnL = pnl;
      series.status = 'won';
      series.endedAt = new Date();
      
      const hedgeNote = hedgeLosses > 0 ? ` (вкл. -$${hedgeLosses.toFixed(2)} хедж)` : '';
      series.addEvent('series_won', {
        pnl,
        message: `Серия завершена победой на Step ${series.currentStep}! P&L: $${pnl.toFixed(2)}${hedgeNote}`,
      });
      
      // Обновляем статистику
      const stats = await TradingStats.getStats(this.botId);
      stats.currentBalance += winAmount;
      stats.totalTrades++;
      stats.wonTrades++;
      stats.totalPnL += pnl;
      stats.totalCommissions += series.totalCommission;
      stats.winsByStep[series.currentStep]++;
      stats.currentStreak = stats.currentStreak >= 0 ? stats.currentStreak + 1 : 1;
      stats.maxWinStreak = Math.max(stats.maxWinStreak, stats.currentStreak);
      await stats.save();
      
      await series.save();
      this.activeSeries.delete(series.asset);
      
      console.log(`[TRADE] [${this.botId}] ${asset}: ✅ SERIES WON at Step ${series.currentStep}! PnL: $${pnl.toFixed(2)}`);
      await this.log(series.asset, series.currentMarketSlug, `✅ SERIES WON Step ${series.currentStep}: won $${winAmount.toFixed(2)}, P&L: $${pnl.toFixed(2)}`, { step: series.currentStep, winAmount, pnl });
      await this.notifyUsers(series, `✅ ПРОФИТ! Step ${series.currentStep}, P&L: $${pnl.toFixed(2)}`);
      
    } else {
      // УБЫТОК этого шага - shares обнуляются
      const currentPosition = series.positions.find(p => p.step === series.currentStep && p.status === 'active');
      if (currentPosition) currentPosition.status = 'lost';
      
      series.addEvent('market_lost', {
        marketColor: resolvedColor,
        message: `Рынок закрылся ${colorEmoji} — проигрыш шага (потеряно $${currentPosition?.amount?.toFixed(2) || '?'})`,
      });
      
      console.log(`[TRADE] [${this.botId}] ${asset}: ❌ Step ${series.currentStep} lost (market: ${resolvedColor})`);
      
      // Проверяем: если следующий шаг уже куплен заранее (хедж)
      if (series.nextStepBought) {
        const nextStep = series.currentStep + 1;
        
        // Проверяем, что следующий шаг не превышает максимальное количество шагов
        if (nextStep > this.config.maxSteps) {
          // Хедж был куплен на шаг, который превышает maxSteps - завершаем серию
          const pnl = -series.totalInvested - series.totalCommission;
          series.totalPnL = pnl;
          series.status = 'lost';
          series.endedAt = new Date();
          
          series.addEvent('series_lost', {
            pnl,
            message: `Серия проиграна после ${series.currentStep} шагов (хедж на Step ${nextStep} превышает maxSteps ${this.config.maxSteps}). P&L: $${pnl.toFixed(2)}`,
          });
          
          // Обновляем статистику
          const stats = await TradingStats.getStats(this.botId);
          stats.totalTrades++;
          stats.lostTrades++;
          stats.totalPnL += pnl;
          stats.totalCommissions += series.totalCommission;
          stats.currentStreak = stats.currentStreak <= 0 ? stats.currentStreak - 1 : -1;
          stats.maxLossStreak = Math.max(stats.maxLossStreak, Math.abs(stats.currentStreak));
          await stats.save();
          
          await series.save();
          this.activeSeries.delete(series.asset);
          
          console.log(`[TRADE] [${this.botId}] ${asset}: ❌ SERIES LOST - hedge on Step ${nextStep} exceeds maxSteps ${this.config.maxSteps}! PnL: $${pnl.toFixed(2)}`);
          await this.log(series.asset, series.currentMarketSlug, `❌ SERIES LOST: hedge Step ${nextStep} > maxSteps ${this.config.maxSteps}, P&L: $${pnl.toFixed(2)}`, { step: series.currentStep, nextStep, maxSteps: this.config.maxSteps, pnl });
          await this.notifyUsers(series, `❌ УБЫТОК! ${series.currentStep} шага, P&L: $${pnl.toFixed(2)}`);
          
          // Создаем cooldown после полного проигрыша
          await this.createCooldown(series.asset);
          return;
        }
        
        // Переходим на уже купленный следующий шаг
        series.currentStep++;
        series.currentMarketSlug = series.nextMarketSlug;
        series.nextStepBought = false;
        series.nextMarketSlug = null;
        series.marketState = 'waiting';
        
        // Сбрасываем состояние валидации хеджа (хедж уже куплен)
        if (series.hedgeValidationState === 'validated' || series.hedgeValidationState === 'validating') {
          series.hedgeValidationState = null;
          series.hedgeValidationHistory = [];
          series.hedgeValidationEventIndex = null;
          series.hedgeValidationMarketSlug = null;
          series.hedgeLastValidationCheck = null;
        }
        
        series.addEvent('waiting_market', {
          message: `Переход на Step ${series.currentStep} (хедж уже куплен)`,
        });
        
        await series.save();
        console.log(`[TRADE] [${this.botId}] ${asset}: Moving to pre-bought Step ${series.currentStep}`);
        return;
      }
      
      if (series.currentStep >= this.config.maxSteps) {
        // Серия проиграна после всех шагов
        const pnl = -series.totalInvested - series.totalCommission;
        series.totalPnL = pnl;
        series.status = 'lost';
        series.endedAt = new Date();
        
        series.addEvent('series_lost', {
          pnl,
          message: `Серия проиграна после ${this.config.maxSteps} шагов. P&L: $${pnl.toFixed(2)}`,
        });
        
        // Обновляем статистику
        const stats = await TradingStats.getStats(this.botId);
        stats.totalTrades++;
        stats.lostTrades++;
        stats.totalPnL += pnl;
        stats.totalCommissions += series.totalCommission;
        stats.currentStreak = stats.currentStreak <= 0 ? stats.currentStreak - 1 : -1;
        stats.maxLossStreak = Math.max(stats.maxLossStreak, Math.abs(stats.currentStreak));
        await stats.save();
        
        await series.save();
        this.activeSeries.delete(series.asset);
        
        console.log(`[TRADE] [${this.botId}] ${asset}: ❌ SERIES LOST after ${this.config.maxSteps} steps! PnL: $${pnl.toFixed(2)}`);
        await this.log(series.asset, series.currentMarketSlug, `❌ SERIES LOST after ${this.config.maxSteps} steps: P&L: $${pnl.toFixed(2)}`, { step: this.config.maxSteps, pnl, totalInvested: series.totalInvested });
        await this.notifyUsers(series, `❌ УБЫТОК! ${this.config.maxSteps} шага, P&L: $${pnl.toFixed(2)}`);
        
        // Создаем cooldown после полного проигрыша
        await this.createCooldown(series.asset);
        
      } else {
        // Проверяем, что следующий шаг не превышает максимальное количество шагов
        const nextStep = series.currentStep + 1;
        if (nextStep > this.config.maxSteps) {
          // Серия проиграна - следующий шаг превышает maxSteps
          const pnl = -series.totalInvested - series.totalCommission;
          series.totalPnL = pnl;
          series.status = 'lost';
          series.endedAt = new Date();
          
          series.addEvent('series_lost', {
            pnl,
            message: `Серия проиграна после ${series.currentStep} шагов (следующий шаг ${nextStep} превышает maxSteps ${this.config.maxSteps}). P&L: $${pnl.toFixed(2)}`,
          });
          
          // Обновляем статистику
          const stats = await TradingStats.getStats(this.botId);
          stats.totalTrades++;
          stats.lostTrades++;
          stats.totalPnL += pnl;
          stats.totalCommissions += series.totalCommission;
          stats.currentStreak = stats.currentStreak <= 0 ? stats.currentStreak - 1 : -1;
          stats.maxLossStreak = Math.max(stats.maxLossStreak, Math.abs(stats.currentStreak));
          await stats.save();
          
          await series.save();
          this.activeSeries.delete(series.asset);
          
          console.log(`[TRADE] [${this.botId}] ${asset}: ❌ SERIES LOST - next step ${nextStep} exceeds maxSteps ${this.config.maxSteps}! PnL: $${pnl.toFixed(2)}`);
          
          // Создаем cooldown после полного проигрыша
          await this.createCooldown(series.asset);
          await this.log(series.asset, series.currentMarketSlug, `❌ SERIES LOST: next step ${nextStep} > maxSteps ${this.config.maxSteps}, P&L: $${pnl.toFixed(2)}`, { step: series.currentStep, nextStep, maxSteps: this.config.maxSteps, pnl });
          await this.notifyUsers(series, `❌ УБЫТОК! ${series.currentStep} шага, P&L: $${pnl.toFixed(2)}`);
          return;
        }
        
        // Следующий шаг Мартингейла (покупаем сейчас)
        series.currentStep++;
        series.currentMarketSlug = context.slugs.current;
        series.marketState = 'waiting';
        
        // Сбрасываем состояние валидации хеджа (если была неудачная валидация)
        if (series.hedgeValidationState === 'rejected' || series.hedgeValidationState === 'validating') {
          series.hedgeValidationState = null;
          series.hedgeValidationHistory = [];
          series.hedgeValidationEventIndex = null;
          series.hedgeValidationMarketSlug = null;
          series.hedgeLastValidationCheck = null;
        }
        
        const bought = await this.buyStep(series);
        if (!bought) {
          // Не удалось купить следующий шаг — отменяем серию
          series.status = 'cancelled';
          series.endedAt = new Date();
          series.addEvent('series_cancelled', {
            message: `⛔ Серия отменена на Step ${series.currentStep}: не удалось купить`,
          });
          
          // Обновляем статистику
          const cancelStats = await TradingStats.getStats(this.botId);
          cancelStats.cancelledTrades++;
          await cancelStats.save();
          
          await series.save();
          this.activeSeries.delete(series.asset);
          console.log(`[TRADE] [${this.botId}] ${asset}: Series cancelled at Step ${series.currentStep} - could not buy`);
          await this.notifyUsers(series, `⛔ Серия отменена на Step ${series.currentStep}`);
          return;
        }
        
        await series.save();
        console.log(`[TRADE] [${this.botId}] ${asset}: Moving to Step ${series.currentStep}`);
        await this.notifyUsers(series, `Step ${series.currentStep}`);
      }
    }
  }

  // ==================== УВЕДОМЛЕНИЯ ====================
  
  async notifyUsers(series, shortMessage) {
    if (!this.bot) return;

    const users = await User.find({ 'signals.tradingNotifications': true });
    if (users.length === 0) return;

    const asset = series.asset.toUpperCase();
    const betEmoji = series.betColor === 'green' ? '🟢' : '🔴';
    
    // Формируем заголовок с информацией о шаге и сумме
    const stepInfo = series.status === 'active' 
      ? `Step ${series.currentStep}/${this.config.maxSteps}`
      : '';
    const amountInfo = series.totalInvested > 0 
      ? `💰 $${series.totalInvested.toFixed(2)}`
      : '';
    
    // Формируем таймлайн, фильтруя пустые сообщения
    const timeline = series.events
      .filter(e => e.message && e.message.trim())
      .map(e => {
        const time = e.timestamp.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return `${time} ${e.message}`;
      })
      .join('\n');
    
    // Формируем сообщение
    let message = `*${asset} ${betEmoji}*\n`;
    if (stepInfo) message += `${stepInfo}\n`;
    if (amountInfo) message += `${amountInfo}\n`;
    message += `\n${shortMessage}`;
    if (timeline) message += `\n\n${timeline}`;

    for (const user of users) {
      try {
        await this.bot.telegram.sendMessage(user.telegramId, message, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error(`Failed to notify ${user.telegramId}:`, error.message);
      }
    }
  }

  // ==================== ДЛЯ ДАШБОРДА ====================
  
  getActiveSeries() {
    const result = {};
    for (const [type, series] of this.activeSeries) {
      result[type] = {
        status: series.status,
        step: series.currentStep,
        betColor: series.betColor,
        marketState: series.marketState,
        totalInvested: series.totalInvested,
        events: series.events,
      };
    }
    return result;
  }

  async getAllSeries(limit = 10) {
    return TradeSeries.find({ botId: this.botId })
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();
  }
}

module.exports = TradingEmulator;
module.exports.TRADING_CONFIGS = TRADING_CONFIGS;
