const mongoose = require('mongoose');

const tradingStatsSchema = new mongoose.Schema({
  // ID бота (для поддержки нескольких ботов)
  _id: { type: String, required: true }, // botId, например 'bot1', 'bot2'
  
  // Баланс
  initialDeposit: { type: Number, default: 100 },
  currentBalance: { type: Number, default: 100 },
  
  // Статистика
  totalTrades: { type: Number, default: 0 },
  wonTrades: { type: Number, default: 0 },
  lostTrades: { type: Number, default: 0 },
  cancelledTrades: { type: Number, default: 0 },
  
  totalPnL: { type: Number, default: 0 },
  totalCommissions: { type: Number, default: 0 },
  
  // Серии
  maxWinStreak: { type: Number, default: 0 },
  maxLossStreak: { type: Number, default: 0 },
  currentStreak: { type: Number, default: 0 }, // + для побед, - для поражений
  
  // По шагам Мартингейла
  winsByStep: {
    1: { type: Number, default: 0 },
    2: { type: Number, default: 0 },
    3: { type: Number, default: 0 },
    4: { type: Number, default: 0 },
  },
  
  updatedAt: { type: Date, default: Date.now },
});

// Статический метод для получения или создания статистики
tradingStatsSchema.statics.getStats = async function(botId = 'bot1') {
  let stats = await this.findById(botId);
  if (!stats) {
    stats = await this.create({ _id: botId });
  }
  return stats;
};

module.exports = mongoose.model('TradingStats', tradingStatsSchema);

