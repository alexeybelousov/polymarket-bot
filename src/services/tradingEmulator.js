const config = require('../config');
const TradeSeries = require('../models/TradeSeries');
const TradingStats = require('../models/TradingStats');
const SignalLog = require('../models/SignalLog');
const User = require('../models/User');

const BET_AMOUNTS = [2, 5, 11, 23]; // Мартингейл
const ENTRY_FEE_RATE = 0.015; // 1.5% комиссия на покупку
const EXIT_FEE_RATE = 0.015; // 1.5% комиссия на продажу

class TradingEmulator {
  constructor(bot, dataProvider) {
    this.bot = bot;
    this.dataProvider = dataProvider;
    this.activeSeries = new Map(); // asset -> TradeSeries
    this.interval = null;
  }

  async start() {
    // Загружаем активные серии из БД
    console.log('💰 Loading active series from DB...');
    const series = await TradeSeries.find({ status: 'active' });
    console.log(`💰 Found ${series.length} active series`);
    
    for (const s of series) {
      this.activeSeries.set(s.asset, s);
      console.log(`💰 Resumed ${s.asset.toUpperCase()} series at Step ${s.currentStep}`);
    }
    
    console.log('💰 Trading emulator started');
    this.interval = setInterval(() => this.tick(), 5000);
  }

  // Логирование в SignalLog
  async log(type, marketSlug, reason, data = {}) {
    try {
      await SignalLog.create({
        type: type || 'unknown',
        marketSlug: marketSlug || 'unknown',
        action: 'trade',
        reason,
        data,
      });
    } catch (e) {
      console.error('Error saving trade log:', e.message);
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('🛑 Trading emulator stopped');
    }
  }

  // ==================== УТИЛИТЫ ====================
  
  /**
   * Конвертирует slug из формата Binance в формат Polymarket
   * Binance: binance-btcusdt-1768309200000 (миллисекунды)
   * Polymarket: btc-updown-15m-1768309200 (секунды)
   */
  convertToPolymarketSlug(slug) {
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
  
  async onSignal(type, signalColor, signalMarketSlug, nextMarketSlug) {
    // Проверяем нет ли активной серии
    if (this.activeSeries.has(type)) {
      console.log(`[TRADE] ${type.toUpperCase()}: Already active series, skipping`);
      return;
    }

    const betColor = signalColor === 'green' ? 'red' : 'green';
    const betEmoji = betColor === 'green' ? '🟢' : '🔴';
    const signalEmoji = signalColor === 'green' ? '🟢' : '🔴';
    
    // Создаём серию
    const series = new TradeSeries({
      asset: type,
      signalMarketSlug: signalMarketSlug, // Рынок где сигнал (для отслеживания отмены)
      signalColor,
      betColor,
      currentStep: 1,
      currentMarketSlug: nextMarketSlug,
      marketState: 'waiting',
    });
    
    // Событие: серия открыта
    series.addEvent('series_opened', {
      message: `Сигнал 3${signalEmoji} → ставим на ${betEmoji}`,
    });
    
    // Покупаем первую ставку
    const bought = await this.buyStep(series);
    if (!bought) return;
    
    await series.save();
    this.activeSeries.set(type, series);
    
    console.log(`[TRADE] ${type.toUpperCase()}: Series opened, betting ${betEmoji} ${betColor.toUpperCase()}`);
    await this.notifyUsers(series, 'Серия открыта');
  }

  // ==================== ПОКУПКА СТАВКИ ====================
  
  async buyStep(series, marketSlugOverride = null) {
    const stats = await TradingStats.getStats();
    const amount = BET_AMOUNTS[series.currentStep - 1];
    const betEmoji = series.betColor === 'green' ? '🟢' : '🔴';
    const betOutcome = series.betColor === 'green' ? 'up' : 'down';
    
    // Проверяем баланс
    if (stats.currentBalance < amount) {
      series.addEvent('insufficient_balance', {
        amount,
        message: `Недостаточно средств: нужно $${amount.toFixed(2)}, есть $${stats.currentBalance.toFixed(2)}`,
      });
      series.status = 'lost';
      series.endedAt = new Date();
      series.addEvent('series_lost', {
        message: 'Серия завершена: недостаточно средств',
      });
      return false;
    }
    
    // Получаем цену с Polymarket (торгуем всегда на Polymarket, даже если сигналы с Binance)
    const targetSlug = marketSlugOverride || series.currentMarketSlug;
    // Конвертируем slug из формата binance в polymarket
    const polySlug = this.convertToPolymarketSlug(targetSlug);
    
    let price = null;
    try {
      const polymarket = require('./polymarket');
      const priceData = await polymarket.getBuyPrice(polySlug, betOutcome);
      if (priceData && priceData.price) {
        price = priceData.price;
        console.log(`[TRADE] Got Polymarket price for ${polySlug}: $${price.toFixed(3)}`);
      }
    } catch (error) {
      console.error(`[TRADE] Error getting Polymarket price for ${polySlug}:`, error.message);
    }
    
    // Если цена не получена — отменяем покупку
    if (!price) {
      console.warn(`[TRADE] Cannot get price for ${polySlug}, skipping buy`);
      series.addEvent('price_error', {
        message: `❌ Не удалось получить цену для ${polySlug}`,
        slug: polySlug,
      });
      return false;
    }
    
    // Расчёты по формуле Polymarket
    const entryFee = amount * ENTRY_FEE_RATE;
    const netAmount = amount - entryFee;
    const shares = netAmount / price;
    
    // Списываем с баланса (amount включает комиссию)
    stats.currentBalance -= amount;
    await stats.save();
    
    // Сохраняем позицию
    series.positions.push({
      step: series.currentStep,
      amount,
      price,
      shares,
      commission: entryFee,
      status: 'active',
    });
    
    series.totalInvested += amount;
    series.totalCommission += entryFee;
    
    // Событие: купили
    series.addEvent('buy', {
      amount,
      message: `Купил ${shares.toFixed(2)} shares по $${price.toFixed(2)} = $${amount} на ${betEmoji} (Step ${series.currentStep})`,
    });
    
    // Событие: ждём рынок
    series.marketState = 'waiting';
    series.addEvent('waiting_market', {
      message: `Жду начало рынка...`,
    });
    
    console.log(`[TRADE] ${series.asset.toUpperCase()}: Buy ${shares.toFixed(2)} shares @ $${price.toFixed(2)} = $${amount} (Step ${series.currentStep})`);
    await this.log(series.asset, series.currentMarketSlug, `BUY Step ${series.currentStep}: ${shares.toFixed(2)} shares @ $${price.toFixed(2)} = $${amount}`, { step: series.currentStep, amount, price, shares });
    return true;
  }

  // ==================== РАННЯЯ ПОКУПКА (ХЕДЖИРОВАНИЕ) ====================
  
  async buyNextStepEarly(series, context) {
    const asset = series.asset.toUpperCase();
    const nextStep = series.currentStep + 1;
    const stats = await TradingStats.getStats();
    const amount = BET_AMOUNTS[nextStep - 1];
    const betEmoji = series.betColor === 'green' ? '🟢' : '🔴';
    const betOutcome = series.betColor === 'green' ? 'up' : 'down';
    const signalEmoji = series.signalColor === 'green' ? '🟢' : '🔴';
    
    // Проверяем баланс
    if (stats.currentBalance < amount) {
      series.addEvent('insufficient_balance', {
        amount,
        message: `Не хватает средств на хедж Step ${nextStep}`,
      });
      await series.save();
      return;
    }
    
    // Получаем цену с Polymarket
    const polySlug = this.convertToPolymarketSlug(context.slugs.next);
    
    let price = null;
    try {
      const polymarket = require('./polymarket');
      const priceData = await polymarket.getBuyPrice(polySlug, betOutcome);
      if (priceData && priceData.price) {
        price = priceData.price;
        console.log(`[TRADE] Got Polymarket price for hedge ${polySlug}: $${price.toFixed(3)}`);
      }
    } catch (error) {
      console.error(`[TRADE] Error getting Polymarket price for hedge ${polySlug}:`, error.message);
    }
    
    // Если цена не получена — отменяем хедж
    if (!price) {
      console.warn(`[TRADE] Cannot get price for hedge ${polySlug}, skipping`);
      series.addEvent('price_error', {
        message: `❌ Не удалось получить цену хеджа для ${polySlug}`,
        slug: polySlug,
      });
      await series.save();
      return;
    }
    
    // Расчёты
    const entryFee = amount * ENTRY_FEE_RATE;
    const netAmount = amount - entryFee;
    const shares = netAmount / price;
    
    // Списываем с баланса
    stats.currentBalance -= amount;
    await stats.save();
    
    // Сохраняем позицию хеджа
    series.positions.push({
      step: nextStep,
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
    series.addEvent('buy', {
      amount,
      step: nextStep,
      message: `⚡ Хедж: ${shares.toFixed(2)} shares @ $${price.toFixed(2)} = $${amount} на ${betEmoji} (Step ${nextStep})`,
    });
    
    await series.save();
    console.log(`[TRADE] ${asset}: ⚡ HEDGE - ${shares.toFixed(2)} shares @ $${price.toFixed(2)} = $${amount} (Step ${nextStep})`);
    await this.log(series.asset, series.nextMarketSlug, `HEDGE Step ${nextStep}: ${shares.toFixed(2)} shares @ $${price.toFixed(2)} = $${amount}`, { step: nextStep, amount, price, shares });
    await this.notifyUsers(series, `⚡ Хедж Step ${nextStep}`);
  }

  // ==================== ОТМЕНА СИГНАЛА ====================
  
  async cancelSignal(series, currentColor) {
    const asset = series.asset.toUpperCase();
    const colorEmoji = currentColor === 'green' ? '🟢' : '🔴';
    const signalEmoji = series.signalColor === 'green' ? '🟢' : '🔴';
    
    const stats = await TradingStats.getStats();
    let totalReturn = 0;
    
    // Продаём все активные позиции
    for (const pos of series.positions) {
      if (pos.status === 'active') {
        const returnAmount = pos.amount * (1 - EXIT_FEE_RATE * 2); // -3%
        totalReturn += returnAmount;
        pos.status = 'sold';
        series.totalCommission += pos.amount * EXIT_FEE_RATE;
      }
    }
    
    stats.currentBalance += totalReturn;
    await stats.save();
    
    // Рассчитываем P&L
    const pnl = totalReturn - series.totalInvested;
    series.totalPnL = pnl;
    series.status = 'lost';
    series.endedAt = new Date();
    series.nextStepBought = false;
    series.nextMarketSlug = null;
    
    series.addEvent('signal_cancelled', {
      marketColor: currentColor,
      pnl,
      message: `⚠️ Сигнал отменён: рынок ${colorEmoji} (был ${signalEmoji}) → вернул $${totalReturn.toFixed(2)}`,
    });
    
    await series.save();
    this.activeSeries.delete(series.asset);
    
    console.log(`[TRADE] ${asset}: ⚠️ SIGNAL CANCELLED - returned $${totalReturn.toFixed(2)}`);
    await this.log(series.asset, series.signalMarketSlug, `SIGNAL CANCELLED: returned $${totalReturn.toFixed(2)}, P&L: $${pnl.toFixed(2)}`, { totalReturn, pnl });
    await this.notifyUsers(series, `⚠️ Сигнал отменён`);
  }

  // ==================== ПРОДАЖА ХЕДЖА ====================
  
  async sellHedge(series) {
    const asset = series.asset.toUpperCase();
    const hedgeStep = series.currentStep + 1;
    const betEmoji = series.betColor === 'green' ? '🟢' : '🔴';
    
    // Находим позицию хеджа
    const hedgePosition = series.positions.find(p => p.step === hedgeStep && p.status === 'active');
    if (!hedgePosition) return;
    
    // При продаже получаем обратно: shares * currentPrice - exitFee
    // Упрощённо: возвращаем ~95% от вложенного (цена примерно та же)
    const returnAmount = hedgePosition.amount * (1 - EXIT_FEE_RATE * 2); // -3% (вход + выход)
    
    const stats = await TradingStats.getStats();
    stats.currentBalance += returnAmount;
    await stats.save();
    
    // Обновляем позицию
    hedgePosition.status = 'sold';
    
    // Корректируем учёт
    series.totalInvested -= hedgePosition.amount;
    series.totalCommission += hedgePosition.amount * EXIT_FEE_RATE;
    series.nextStepBought = false;
    series.nextMarketSlug = null;
    
    const loss = hedgePosition.amount - returnAmount;
    
    // Учитываем потерю от продажи хеджа
    series.hedgeLosses = (series.hedgeLosses || 0) + loss;
    
    // Событие: продали хедж
    series.addEvent('sell_hedge', {
      amount: returnAmount,
      step: hedgeStep,
      message: `📤 Продал хедж Step ${hedgeStep}: вернул $${returnAmount.toFixed(2)} (-$${loss.toFixed(2)})`,
    });
    
    await series.save();
    console.log(`[TRADE] ${asset}: 📤 SELL HEDGE - Returned $${returnAmount.toFixed(2)} (Step ${hedgeStep})`);
    await this.log(series.asset, series.currentMarketSlug, `SELL HEDGE Step ${hedgeStep}: returned $${returnAmount.toFixed(2)} (-$${loss.toFixed(2)})`, { step: hedgeStep, returnAmount, loss });
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
        console.log(`[TRADE] ${asset} Step ${series.currentStep}: ⏳ Waiting for market...`);
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
        console.log(`[TRADE] ${asset} Step ${series.currentStep}: 📊 Market is now active`);
      }
      
      // РАННЯЯ ПОКУПКА: если рынок идёт против нас (цвет = signalColor), покупаем следующий шаг заранее
      if (!series.nextStepBought && series.currentStep < 4 && currentColor === series.signalColor) {
        await this.buyNextStepEarly(series, context);
      }
      
      // ПРОДАЖА ХЕДЖА: за 20 сек до конца, если рынок наш цвет — продаём хедж
      const timeToEnd = context.current.timeToEnd;
      if (series.nextStepBought && currentColor === series.betColor && timeToEnd <= 20) {
        await this.sellHedge(series);
      }
      
      if (config.debug) {
        const hedgeInfo = series.nextStepBought ? ' [HEDGED]' : '';
        console.log(`[TRADE] ${asset} Step ${series.currentStep}: ${colorEmoji} ${currentColor} | ${timeToEnd}s left${hedgeInfo}`);
      }
      return;
    }

    // 3. Наш рынок закрылся (стал prev1)
    if (ourTimestamp === prev1Timestamp) {
      const resolvedColor = context.previous[1].color;
      
      if (resolvedColor === 'unknown') {
        console.log(`[TRADE] ${asset}: Market closed but color unknown, waiting...`);
        return;
      }
      
      await this.resolveMarket(series, resolvedColor, context);
      return;
    }

    // 4. Потеряли рынок
    console.log(`[TRADE] ${asset}: WARNING - Lost track of market`);
  }

  // ==================== РЕЗОЛВ РЫНКА ====================
  
  async resolveMarket(series, resolvedColor, context) {
    const asset = series.asset.toUpperCase();
    const won = resolvedColor === series.betColor;
    const colorEmoji = resolvedColor === 'green' ? '🟢' : '🔴';
    
    series.marketState = 'closed';
    
    if (won) {
      // ПОБЕДА! Получаем shares (каждая = $1)
      const currentPosition = series.positions.find(p => p.step === series.currentStep && p.status === 'active');
      const shares = currentPosition?.shares || 0;
      const winAmount = shares; // shares * $1
      
      // Обновляем статус позиции
      if (currentPosition) currentPosition.status = 'won';
      
      // P&L = выигрыш - вложено - потери на хеджах
      const hedgeLosses = series.hedgeLosses || 0;
      const pnl = winAmount - series.totalInvested - hedgeLosses;
      
      series.addEvent('market_won', {
        marketColor: resolvedColor,
        pnl: winAmount - currentPosition?.amount,
        message: `Рынок закрылся ${colorEmoji} — ПОБЕДА! Получил $${winAmount.toFixed(2)} (+$${(winAmount - currentPosition?.amount).toFixed(2)})`,
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
      const stats = await TradingStats.getStats();
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
      
      console.log(`[TRADE] ${asset}: ✅ SERIES WON at Step ${series.currentStep}! PnL: $${pnl.toFixed(2)}`);
      await this.log(series.asset, series.currentMarketSlug, `✅ SERIES WON Step ${series.currentStep}: won $${winAmount.toFixed(2)}, P&L: $${pnl.toFixed(2)}`, { step: series.currentStep, winAmount, pnl });
      await this.notifyUsers(series, `✅ ПОБЕДА! Step ${series.currentStep}, P&L: $${pnl.toFixed(2)}`);
      
    } else {
      // ПРОИГРЫШ этого шага - shares обнуляются
      const currentPosition = series.positions.find(p => p.step === series.currentStep && p.status === 'active');
      if (currentPosition) currentPosition.status = 'lost';
      
      series.addEvent('market_lost', {
        marketColor: resolvedColor,
        message: `Рынок закрылся ${colorEmoji} — проигрыш шага (потеряно $${currentPosition?.amount?.toFixed(2) || '?'})`,
      });
      
      console.log(`[TRADE] ${asset}: ❌ Step ${series.currentStep} lost (market: ${resolvedColor})`);
      
      // Проверяем: если следующий шаг уже куплен заранее (хедж)
      if (series.nextStepBought) {
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
        console.log(`[TRADE] ${asset}: Moving to pre-bought Step ${series.currentStep}`);
        return;
      }
      
      if (series.currentStep >= 4) {
        // Серия проиграна после 4 шагов
        const pnl = -series.totalInvested - series.totalCommission;
        series.totalPnL = pnl;
        series.status = 'lost';
        series.endedAt = new Date();
        
        series.addEvent('series_lost', {
          pnl,
          message: `Серия проиграна после 4 шагов. P&L: $${pnl.toFixed(2)}`,
        });
        
        // Обновляем статистику
        const stats = await TradingStats.getStats();
        stats.totalTrades++;
        stats.lostTrades++;
        stats.totalPnL += pnl;
        stats.totalCommissions += series.totalCommission;
        stats.currentStreak = stats.currentStreak <= 0 ? stats.currentStreak - 1 : -1;
        stats.maxLossStreak = Math.max(stats.maxLossStreak, Math.abs(stats.currentStreak));
        await stats.save();
        
        await series.save();
        this.activeSeries.delete(series.asset);
        
        console.log(`[TRADE] ${asset}: ❌ SERIES LOST after 4 steps! PnL: $${pnl.toFixed(2)}`);
        await this.log(series.asset, series.currentMarketSlug, `❌ SERIES LOST after 4 steps: P&L: $${pnl.toFixed(2)}`, { step: 4, pnl, totalInvested: series.totalInvested });
        await this.notifyUsers(series, `❌ ПРОИГРЫШ! 4 шага, P&L: $${pnl.toFixed(2)}`);
        
      } else {
        // Следующий шаг Мартингейла (покупаем сейчас)
        series.currentStep++;
        series.currentMarketSlug = context.slugs.current;
        series.marketState = 'waiting';
        
        const bought = await this.buyStep(series);
        if (!bought) {
          await series.save();
          this.activeSeries.delete(series.asset);
          return;
        }
        
        await series.save();
        console.log(`[TRADE] ${asset}: Moving to Step ${series.currentStep}`);
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
    
    // Формируем полный таймлайн
    const timeline = series.events.map(e => {
      const time = e.timestamp.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `${time} ${e.message}`;
    }).join('\n');
    
    const message = `💰 *${asset} ${betEmoji}* — ${shortMessage}\n\n${timeline}`;

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
    return TradeSeries.find()
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();
  }
}

module.exports = TradingEmulator;
