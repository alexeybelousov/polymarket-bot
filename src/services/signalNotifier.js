const Signal = require('../models/Signal');
const User = require('../models/User');
const SignalLog = require('../models/SignalLog');
const polymarket = require('./polymarket');

class SignalNotifier {
  constructor(bot) {
    this.bot = bot;
    this.interval = null;
  }

  start() {
    console.log('📤 Signal notifier started');
    this.interval = setInterval(() => {
      this.processNewSignals();
    }, 2000);
    this.processNewSignals();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('🛑 Signal notifier stopped');
    }
  }

  async processNewSignals() {
    try {
      const signals = await Signal.find({ status: 'detected' }).sort({ detectedAt: 1 });
      for (const signal of signals) {
        await this.sendSignal(signal);
      }
    } catch (error) {
      console.error('Error processing signals:', error.message);
    }
  }

  async sendSignal(signal) {
    const { type, candleCount, color, candles, timeToEnd, nextMarketUrl } = signal;
    const asset = type.toUpperCase();

    const signalField = `signals.${type}${candleCount}candles`;
    const users = await User.find({ [signalField]: true });

    if (users.length === 0) {
      await Signal.findByIdAndUpdate(signal._id, { status: 'sent', sentTo: [] });
      return;
    }

    const colorEmoji = color === 'green' ? '🟢' : '🔴';
    const timeText = polymarket.formatTimeToEnd(timeToEnd);

    const candleLines = candles.map((candle, index) => {
      const emoji = candle.color === 'green' ? '🟢' : '🔴';
      const isCurrent = index === candles.length - 1;
      return `  ${candle.endTime} ${emoji}${isCurrent ? ' ← текущая' : ''}`;
    });

    const nextTs = polymarket.getTimestampFromSlug(signal.nextMarketSlug);
    const nextTime = polymarket.formatTimeET(nextTs + 900);

    const message = `*Сигнал ${asset} (${candleCount} свечи)*\n\n` +
      `📊 Свечи:\n${candleLines.join('\n')}\n\n` +
      `До конца рынка: ${timeText}\n\n` +
      `[Открыть ${nextTime}](${nextMarketUrl})`;

    console.log(`📤 Sending ${asset} ${candleCount}c signal to ${users.length} users`);

    const sentTo = [];
    for (const user of users) {
      try {
        await this.bot.telegram.sendMessage(user.telegramId, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
        sentTo.push(user.telegramId);
      } catch (error) {
        console.error(`Failed to send to ${user.telegramId}:`, error.message);
      }
    }

    await Signal.findByIdAndUpdate(signal._id, { status: 'sent', sentTo });
    await SignalLog.create({
      type, marketSlug: signal.marketSlug, action: 'send',
      reason: `Sent to ${sentTo.length} users`, data: { signalId: signal._id, sentTo },
    });
  }
}

module.exports = SignalNotifier;

