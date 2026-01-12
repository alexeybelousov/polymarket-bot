const config = require('../config');
const polymarket = require('./polymarket');
const storage = require('./storage');

// TODO: Раскомментировать когда MongoDB будет готова
// const User = require('../models/User');

// Debug логирование
function debug(...args) {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
}

class SignalTracker {
  constructor(bot) {
    this.bot = bot;
    this.interval = null;
    
    // Состояние для отслеживания цвета и времени удержания
    this.colorState = {
      eth: { color: null, since: null },
      btc: { color: null, since: null },
    };
    
    // Отслеживаем последний интервал чтобы сбрасывать состояние при смене
    this.lastInterval = {
      eth: null,
      btc: null,
    };
    
    // Отдельно храним для какого интервала уже отправлен сигнал
    // Не сбрасывается при изменении цвета!
    this.signalSentFor = {
      eth: null,
      btc: null,
    };
  }

  start() {
    console.log('🚀 Signal tracker started');
    if (config.debug) {
      console.log('🐛 Debug mode enabled');
    }
    this.interval = setInterval(() => {
      this.checkSignals();
    }, config.polymarket.checkInterval);
    
    // Первая проверка сразу
    this.checkSignals();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('🛑 Signal tracker stopped');
    }
  }

  async checkSignals() {
    try {
      await Promise.all([
        this.checkMarket('eth', config.polymarket.markets.eth),
        this.checkMarket('btc', config.polymarket.markets.btc),
      ]);
    } catch (error) {
      console.error('Error checking signals:', error.message);
    }
  }

  async checkMarket(type, baseSlug) {
    try {
      const context = await polymarket.get15mContext(baseSlug);
      const asset = type.toUpperCase();
      
      // Проверяем смену интервала - сбрасываем состояние
      if (this.lastInterval[type] !== context.slugs.current) {
        this.lastInterval[type] = context.slugs.current;
        this.colorState[type] = { color: null, since: null };
        // signalSentFor сбрасывается только при смене интервала
        this.signalSentFor[type] = null;
        console.log(`📊 New interval for ${asset}: ${context.slugs.current}`);
      }
      
      // Проверяем, был ли уже отправлен сигнал для этого интервала
      if (this.signalSentFor[type] === context.slugs.current) {
        debug(`  ⏸ Signal already sent for ${context.slugs.current}`);
        return;
      }

      // Проверяем условия для сигнала
      const { current, previous } = context;
      const prev2Data = previous[0]; // prev2 (самый старый)
      const prev1Data = previous[1]; // prev1
      
      // Форматирование информации о цвете для логов
      const formatColorInfo = (data) => {
        let info = `${data.color} [${data.source}]`;
        if (data.prices && typeof data.prices.start === 'number' && typeof data.prices.current === 'number') {
          info += ` (Start:${data.prices.start.toFixed(3)} Current:${data.prices.current.toFixed(3)})`;
        }
        return info;
      };
      
      debug(`--- ${asset} Check ---`);
      debug(`  Prev2 (oldest): ${formatColorInfo(prev2Data)}`);
      debug(`  Prev1: ${formatColorInfo(prev1Data)}`);
      debug(`  Current: ${formatColorInfo(current)}`);
      debug(`  Active: ${current.active}`);
      debug(`  Time to end: ${current.timeToEnd}s`);
      
      const prev1Color = prev2Data.color;
      const prev2Color = prev1Data.color;
      
      // 1. Рынок должен быть активным
      if (!current.active) {
        debug(`  ❌ Market not active`);
        return;
      }

      // 2. До конца рынка должно быть минимум 1 минута
      if (current.timeToEnd < config.polymarket.minTimeBeforeEnd) {
        debug(`  ❌ Too close to end (< ${config.polymarket.minTimeBeforeEnd}s)`);
        return;
      }

      // 3. Две предыдущие свечи одного цвета
      if (prev1Color !== prev2Color) {
        debug(`  ❌ Previous candles different colors`);
        return;
      }
      
      if (prev1Color === 'unknown') {
        debug(`  ❌ Previous candles color unknown`);
        return;
      }

      const targetColor = prev1Color; // green или red
      debug(`  ✓ Target color: ${targetColor}`);

      // 4. Текущая свеча того же цвета
      if (current.color !== targetColor) {
        debug(`  ❌ Current candle is ${current.color}, need ${targetColor}`);
        // Цвет изменился - сбрасываем таймер (но НЕ signalSentFor!)
        this.colorState[type] = { color: null, since: null };
        return;
      }

      debug(`  ✓ Current candle matches target color`);

      // 5. Отслеживаем время удержания цвета
      const now = Date.now();
      const state = this.colorState[type];

      if (state.color !== targetColor) {
        // Цвет только что стал нужным - начинаем отсчёт
        debug(`  🕐 Starting hold timer for ${targetColor}`);
        this.colorState[type] = {
          color: targetColor,
          since: now,
        };
        return;
      }

      // 6. Проверяем, прошло ли 10 секунд
      const holdTime = (now - state.since) / 1000;
      debug(`  Hold time: ${holdTime.toFixed(1)}s / ${config.polymarket.colorHoldTime}s`);
      
      if (holdTime >= config.polymarket.colorHoldTime) {
        debug(`  🎯 SIGNAL TRIGGERED!`);
        // Сигнал! Отправляем с контекстом
        await this.sendSignal(type, targetColor, context);
        // Запоминаем что для этого интервала сигнал уже отправлен
        this.signalSentFor[type] = context.slugs.current;
      } else {
        debug(`  ⏳ Waiting... ${(config.polymarket.colorHoldTime - holdTime).toFixed(1)}s left`);
      }

    } catch (error) {
      console.error(`Error checking ${type} market:`, error.message);
    }
  }

  async sendSignal(type, color, context) {
    const colorEmoji = color === 'green' ? '🟢' : '🔴';
    const colorText = color === 'green' ? 'зелёных' : 'красных';
    const asset = type.toUpperCase();
    const timeText = polymarket.formatTimeToEnd(context.current.timeToEnd);

    // Получаем времена ОКОНЧАНИЯ для каждой свечи (+15 мин к началу)
    const step = 900; // 15 минут
    const prev2Ts = polymarket.getTimestampFromSlug(context.slugs.prev2);
    const prev1Ts = polymarket.getTimestampFromSlug(context.slugs.prev1);
    const currentTs = polymarket.getTimestampFromSlug(context.slugs.current);

    // Показываем время окончания (как на сайте Polymarket)
    const prev2Time = polymarket.formatTimeET(prev2Ts + step);
    const prev1Time = polymarket.formatTimeET(prev1Ts + step);
    const currentTime = polymarket.formatTimeET(currentTs + step);

    // Следующий рынок (для торговли)
    const nextTs = currentTs + step;
    const nextTime = polymarket.formatTimeET(nextTs + step); // время окончания следующего
    const baseSlug = context.slugs.current.replace(/-\d+$/, ''); // eth-updown-15m
    const nextSlug = `${baseSlug}-${nextTs}`;
    const nextUrl = polymarket.getMarketUrl(nextSlug);

    const message = `${colorEmoji} *3 ${colorText} свечи ${asset}!*\n\n` +
      `📊 Свечи:\n` +
      `  ${prev2Time} ${colorEmoji}\n` +
      `  ${prev1Time} ${colorEmoji}\n` +
      `  ${currentTime} ${colorEmoji} ← текущая\n\n` +
      `До конца рынка: ${timeText}\n\n` +
      `[Открыть ${nextTime}](${nextUrl})`;

    // Получаем пользователей с включёнными сигналами для этого типа
    // TODO: Раскомментировать когда MongoDB будет готова
    // const signalField = type === 'eth' ? 'signals.eth3candles' : 'signals.btc3candles';
    // const users = await User.find({ [signalField]: true });
    
    // JSON storage вариант
    const users = storage.getUsersWithSignal(type);

    console.log(`📤 Sending ${asset} signal to ${users.length} users`);
    debug(`  Users: ${users.map(u => u.telegramId).join(', ') || 'none'}`);

    // Отправляем сообщения всем подписанным пользователям
    for (const user of users) {
      try {
        await this.bot.telegram.sendMessage(user.telegramId, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
        debug(`  ✓ Sent to ${user.telegramId}`);
      } catch (error) {
        console.error(`Failed to send signal to user ${user.telegramId}:`, error.message);
      }
    }
  }
}

module.exports = SignalTracker;
