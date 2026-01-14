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
    breakEvenOnLastStep: true,  // На последнем шаге просто покрываем убытки без прибыли
  },
};

/**
 * Динамический расчёт ставки на основе цены
 * Формула: profitMultiplier = (1 - fee) / price - 1
 * betAmount = (previousLosses + targetProfit) / profitMultiplier
 */
function calculateDynamicBet(buyPrice, previousLosses, targetProfit, entryFeeRate) {
  const profitMultiplier = (1 - entryFeeRate) / buyPrice - 1;
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
    
    console.log(`[TRADE] [${botId}] Initialized with ENTRY_FEE_RATE: ${this.ENTRY_FEE_RATE}, EXIT_FEE_RATE: ${this.EXIT_FEE_RATE}`);
  }

  async start() {
    // Загружаем активные серии из БД для этого бота
    console.log(`💰 [${this.botId}] Loading active series from DB...`);
    const series = await TradeSeries.find({ botId: this.botId, status: 'active' });
    console.log(`💰 [${this.botId}] Found ${series.length} active series`);
    
    for (const s of series) {
      this.activeSeries.set(s.asset, s);
      console.log(`💰 [${this.botId}] Resumed ${s.asset.toUpperCase()} series at Step ${s.currentStep}`);
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
    
    // Проверяем нет ли активной серии
    if (this.activeSeries.has(type)) {
      console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Already active series, skipping`);
      return;
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
      message: `Сигнал ${candleCount}${signalEmoji} → ставим на ${betEmoji}`,
    });
    
    console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Series created, calling buyStep...`);
    
    // Покупаем первую ставку
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
    const profitMultiplier = (1 - this.ENTRY_FEE_RATE) / price - 1;
    const firstBetAmount = deposit * this.config.firstBetPercent;
    
    // Если это последний шаг и breakEvenOnLastStep = true, то просто покрываем убытки без прибыли
    let targetProfit;
    if (series.currentStep === this.config.maxSteps && this.config.breakEvenOnLastStep) {
      targetProfit = 0; // Просто покрываем убытки, без прибыли
      console.log(`[TRADE] [${this.botId}] ${series.asset.toUpperCase()}: Last step (${series.currentStep}), breakEven mode - no profit, just covering losses`);
    } else {
      targetProfit = firstBetAmount * profitMultiplier; // Обычная логика с прибылью
    }
    
    const amount = calculateDynamicBet(price, previousLosses, targetProfit, this.ENTRY_FEE_RATE);
    
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
    // Используем текущий баланс для расчёта первой ставки (2% от баланса)
    const deposit = stats.currentBalance || this.config.baseDeposit;
    const previousLosses = series.totalInvested || 0;
    const profitMultiplier = (1 - this.ENTRY_FEE_RATE) / price - 1;
    const firstBetAmount = deposit * this.config.firstBetPercent;
    
    // Если следующий шаг - последний и breakEvenOnLastStep = true, то просто покрываем убытки без прибыли
    let targetProfit;
    if (nextStep === this.config.maxSteps && this.config.breakEvenOnLastStep) {
      targetProfit = 0; // Просто покрываем убытки, без прибыли
      console.log(`[TRADE] [${this.botId}] ${asset}: Hedge for last step (${nextStep}), breakEven mode - no profit, just covering losses`);
    } else {
      targetProfit = firstBetAmount * profitMultiplier; // Обычная логика с прибылью
    }
    
    const amount = calculateDynamicBet(price, previousLosses, targetProfit, this.ENTRY_FEE_RATE);
    
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
    await this.log(series.asset, series.signalMarketSlug, 'signal_cancelled', `SIGNAL CANCELLED: returned $${totalReturn.toFixed(2)}, P&L: $${pnl.toFixed(2)}`, { totalReturn, pnl });
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
    let orderBookSize = null;
    
    try {
      const priceData = await polymarket.getSellPrice(polySlug, betOutcome);
      if (priceData && priceData.price) {
        sellPrice = priceData.price;
        sellTokenId = priceData.tokenId;
        console.log(`[TRADE] [${this.botId}] Got sell price for hedge ${polySlug}: $${sellPrice.toFixed(3)}`);
        
        // Если это продажа за 20 секунд до конца, получаем размер order book
        if (timeToEnd !== null && timeToEnd <= 20 && sellTokenId) {
          try {
            orderBookSize = await polymarket.getOrderBookSize(sellTokenId);
            if (orderBookSize) {
              console.log(`[TRADE] [${this.botId}] Order book size for hedge: ${orderBookSize.totalSize.toFixed(2)} (bids: ${orderBookSize.bidsSize.toFixed(2)}, asks: ${orderBookSize.asksSize.toFixed(2)})`);
            }
          } catch (error) {
            console.error(`[TRADE] Error getting order book size:`, error.message);
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
    let orderBookText = '';
    if (orderBookSize && timeToEnd !== null && timeToEnd <= 20) {
      orderBookText = ` | OB: ${orderBookSize.totalSize.toFixed(2)}`;
    }
    series.addEvent('sell_hedge', {
      amount: returnAmount,
      step: hedgeStep,
      message: `📤 Продал хедж Step ${hedgeStep}${priceText ? ` ${priceText}` : ''}${orderBookText}: вернул $${returnAmount.toFixed(2)} ($${loss.toFixed(2)})`,
    });
    
    await series.save();
    console.log(`[TRADE] [${this.botId}] ${asset}: 📤 SELL HEDGE - Returned $${returnAmount.toFixed(2)} (Step ${hedgeStep})`);
    await this.log(series.asset, series.currentMarketSlug, `SELL HEDGE Step ${hedgeStep}: returned $${returnAmount.toFixed(2)} ($${loss.toFixed(2)})`, { step: hedgeStep, returnAmount, loss });
    await this.notifyUsers(series, `📤 Продал хедж`);
  }

  // ==================== ПРОВЕРКА КАЖДЫЕ 5 СЕК ====================
  
  async tick() {
    for (const [type, series] of this.activeSeries) {
      try {
        await this.checkSeries(series);
      } catch (error) {
        console.error(`[TRADE] Error checking ${type}:`, error.message);
      }
    }
  }

  async checkSeries(series) {
    const isBinance = config.dataSource === 'binance';
    const context = isBinance 
      ? await this.dataProvider.get15mContext(series.asset)
      : await this.dataProvider.get15mContext(config.polymarket.markets[series.asset]);

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
        await this.buyNextStepEarly(series, context);
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
          return;
        }
        
        // Переходим на уже купленный следующий шаг
        series.currentStep++;
        series.currentMarketSlug = series.nextMarketSlug;
        series.nextStepBought = false;
        series.nextMarketSlug = null;
        series.marketState = 'waiting';
        
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
          await this.log(series.asset, series.currentMarketSlug, `❌ SERIES LOST: next step ${nextStep} > maxSteps ${this.config.maxSteps}, P&L: $${pnl.toFixed(2)}`, { step: series.currentStep, nextStep, maxSteps: this.config.maxSteps, pnl });
          await this.notifyUsers(series, `❌ УБЫТОК! ${series.currentStep} шага, P&L: $${pnl.toFixed(2)}`);
          return;
        }
        
        // Следующий шаг Мартингейла (покупаем сейчас)
        series.currentStep++;
        series.currentMarketSlug = context.slugs.current;
        series.marketState = 'waiting';
        
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
