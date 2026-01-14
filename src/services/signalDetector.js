const config = require('../config');
const polymarket = require('./polymarket');
const binance = require('./binance');
const Signal = require('../models/Signal');
const SignalLog = require('../models/SignalLog');

// Выбираем источник данных
const isBinance = config.dataSource === 'binance';
const dataProvider = isBinance ? binance : polymarket;

class SignalDetector {
  constructor(tradingEmulators = null) {
    // Поддерживаем как один бот (для обратной совместимости), так и массив ботов
    this.tradingEmulators = Array.isArray(tradingEmulators) 
      ? tradingEmulators 
      : tradingEmulators ? [tradingEmulators] : [];
    this.interval = null;
    this.colorState = {
      eth3: { color: null, since: null },
      eth2: { color: null, since: null },
      btc3: { color: null, since: null },
      btc2: { color: null, since: null },
    };
    this.lastInterval = {
      eth: null,
      btc: null,
    };
  }

  start() {
    const source = config.dataSource.toUpperCase();
    console.log(`🔍 Signal detector started (source: ${source})`);
    this.interval = setInterval(() => {
      this.checkAllMarkets();
    }, config.polymarket.checkInterval);
    this.checkAllMarkets();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('🛑 Signal detector stopped');
    }
  }

  async checkAllMarkets() {
    try {
      await Promise.all([
        this.checkMarket('eth'),
        this.checkMarket('btc'),
      ]);
    } catch (error) {
      console.error('Error checking markets:', error.message);
    }
  }

  async log(type, marketSlug, action, reason, data = {}) {
    try {
      await SignalLog.create({ type, marketSlug, action, reason, data });
    } catch (error) {
      console.error('Error saving log:', error.message);
    }
  }

  async checkMarket(type) {
    try {
      // Для Binance передаём type, для Polymarket - baseSlug
      const context = isBinance 
        ? await dataProvider.get15mContext(type)
        : await dataProvider.get15mContext(config.polymarket.markets[type]);
      
      const asset = type.toUpperCase();

      if (this.lastInterval[type] !== context.slugs.current) {
        this.lastInterval[type] = context.slugs.current;
        this.colorState[`${type}3`] = { color: null, since: null };
        this.colorState[`${type}2`] = { color: null, since: null };
        console.log(`📊 New interval for ${asset}: ${context.slugs.current}`);
      }

      const { current, previous } = context;
      const prev2Data = previous[0];
      const prev1Data = previous[1];

      const formatColorInfo = (data) => {
        let info = `${data?.color || 'unknown'}`;
        if (data?.resolved) info += '✓';
        info += ` [${data?.source || '?'}]`;
        try {
          if (data?.prices?.start != null && data?.prices?.current != null) {
            const start = Number(data.prices.start);
            const cur = Number(data.prices.current);
            // Для Binance показываем цены как есть, для Polymarket - округляем
            if (isBinance) {
              info += ` ($${start.toFixed(0)}→$${cur.toFixed(0)})`;
            } else {
              info += ` (${start.toFixed(2)}→${cur.toFixed(2)})`;
            }
          }
        } catch {}
        return info;
      };

      if (config.debug) {
        console.log(`[${asset}] P2:${formatColorInfo(prev2Data)} | P1:${formatColorInfo(prev1Data)} | Cur:${formatColorInfo(current)} | ${current.timeToEnd}s`);
      }

      await this.checkFor3Candles(type, context, prev2Data, prev1Data, current);
      await this.checkFor2Candles(type, context, prev1Data, current);

    } catch (error) {
      console.error(`Error checking ${type} market:`, error.message);
      await this.log(type, 'unknown', 'error', error.message);
    }
  }

  async checkFor3Candles(type, context, prev2Data, prev1Data, current) {
    const candleCount = 3;
    const marketSlug = context.slugs.current;
    const stateKey = `${type}3`;

    const existingSignal = await Signal.findOne({ type, marketSlug, candleCount });
    if (existingSignal) return;

    if (!current.active) return;
    if (current.timeToEnd < config.polymarket.minTimeBeforeEnd) return;

    if (prev2Data.color === 'unknown' || prev1Data.color === 'unknown') return;
    if (prev2Data.color !== prev1Data.color) return;

    const targetColor = prev1Data.color;
    if (current.color !== targetColor) {
      this.colorState[stateKey] = { color: null, since: null };
      return;
    }

    const now = Date.now();
    const state = this.colorState[stateKey];

    if (state.color !== targetColor) {
      this.colorState[stateKey] = { color: targetColor, since: now };
      return;
    }

    const holdTime = (now - state.since) / 1000;
    if (holdTime < config.polymarket.colorHoldTime) return;

    await this.saveSignal(type, candleCount, targetColor, context, [prev2Data, prev1Data, current]);
  }

  async checkFor2Candles(type, context, prev1Data, current) {
    const candleCount = 2;
    const marketSlug = context.slugs.current;
    const stateKey = `${type}2`;

    const existingSignal = await Signal.findOne({ type, marketSlug, candleCount });
    if (existingSignal) return;

    if (!current.active) return;
    if (current.timeToEnd < config.polymarket.minTimeBeforeEnd) return;

    if (prev1Data.color === 'unknown') return;

    const targetColor = prev1Data.color;
    if (current.color !== targetColor) {
      this.colorState[stateKey] = { color: null, since: null };
      return;
    }

    const now = Date.now();
    const state = this.colorState[stateKey];

    if (state.color !== targetColor) {
      this.colorState[stateKey] = { color: targetColor, since: now };
      return;
    }

    const holdTime = (now - state.since) / 1000;
    if (holdTime < config.polymarket.colorHoldTime) return;

    await this.saveSignal(type, candleCount, targetColor, context, [prev1Data, current]);
  }

  async saveSignal(type, candleCount, color, context, candlesData) {
    const asset = type.toUpperCase();
    const step = 900 * 1000; // 15 min in ms for Binance

    const candles = candlesData.map((data, index) => {
      let slug;
      if (candleCount === 3) {
        slug = index === 0 ? context.slugs.prev2 : (index === 1 ? context.slugs.prev1 : context.slugs.current);
      } else {
        slug = index === 0 ? context.slugs.prev1 : context.slugs.current;
      }
      const endTime = data.marketInfo?.endDate 
        ? new Date(data.marketInfo.endDate).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })
        : '';
      return { slug, color: data.color, source: data.source, prices: data.prices, resolved: data.resolved || false, endTime };
    });

    const nextMarketUrl = dataProvider.getMarketUrl(context.slugs.next || context.slugs.current);

    try {
      const signal = await Signal.create({
        type, candleCount, color,
        marketSlug: context.slugs.current,
        nextMarketSlug: context.slugs.next || context.slugs.current,
        nextMarketUrl,
        candles,
        status: 'detected',
        timeToEnd: context.current.timeToEnd,
      });

      console.log(`🎯 Signal detected: ${asset} ${candleCount}c ${color} (${context.current.timeToEnd}s left)`);
      await this.log(type, context.slugs.current, 'detect', `${candleCount}c ${color} signal`, { signalId: signal._id });

      // Передаем сигнал всем ботам - каждый бот сам решает, торговать ли ему на основе своего конфига
      if (this.tradingEmulators.length > 0) {
        const nextMarketSlug = context.slugs.next || context.slugs.current;
        const signalType = candleCount === 3 ? '3candles' : '2candles';
        console.log(`[SIGNAL] Calling tradingEmulator.onSignal for ${type.toUpperCase()} ${candleCount}c (${this.tradingEmulators.length} bot(s))...`);
        // Передаем сигнал всем ботам - они сами проверят, соответствует ли сигнал их конфигу
        for (const emulator of this.tradingEmulators) {
          try {
            await emulator.onSignal(type, color, context.slugs.current, nextMarketSlug, signalType);
          } catch (err) {
            console.error(`[SIGNAL] Error in tradingEmulator.onSignal for ${emulator.botId}:`, err.message);
          }
        }
      } else {
        console.log(`[SIGNAL] No trading emulators configured!`);
      }

      return signal;
    } catch (error) {
      if (error.code === 11000) return null;
      throw error;
    }
  }
}

module.exports = SignalDetector;
