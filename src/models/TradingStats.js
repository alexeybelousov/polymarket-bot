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

// Атомарное списание баланса (защита от race condition)
tradingStatsSchema.statics.deductBalance = async function(botId, amount) {
  console.log(`[TradingStats] deductBalance called: botId=${botId}, amount=$${amount.toFixed(2)}`);
  
  // Сначала получаем текущий баланс для логирования
  const beforeStats = await this.findById(botId);
  const balanceBefore = beforeStats ? beforeStats.currentBalance : null;
  console.log(`[TradingStats] Balance before deduction: $${balanceBefore?.toFixed(2) || 'N/A'}`);
  
  const result = await this.findOneAndUpdate(
    { 
      _id: botId,
      currentBalance: { $gte: amount } // Проверяем, что баланс достаточен
    },
    { 
      $inc: { currentBalance: -amount },
      $set: { updatedAt: new Date() }
    },
    { 
      new: true, // Возвращаем обновленный документ
      runValidators: true
    }
  );
  
  if (!result) {
    // Если не удалось обновить (недостаточно средств или документ не найден)
    const stats = await this.findById(botId);
    if (!stats) {
      console.error(`[TradingStats] TradingStats not found for botId: ${botId}`);
      throw new Error(`TradingStats not found for botId: ${botId}`);
    }
    if (stats.currentBalance < amount) {
      console.error(`[TradingStats] Insufficient balance: need $${amount.toFixed(2)}, have $${stats.currentBalance.toFixed(2)}`);
      throw new Error(`Insufficient balance: need $${amount}, have $${stats.currentBalance}`);
    }
    // Если документ существует и баланс достаточен, но обновление не прошло - возможно race condition
    console.error(`[TradingStats] Failed to deduct balance atomically for botId: ${botId}, balance: $${stats.currentBalance.toFixed(2)}, amount: $${amount.toFixed(2)}`);
    throw new Error(`Failed to deduct balance atomically for botId: ${botId}`);
  }
  
  console.log(`[TradingStats] Balance after deduction: $${result.currentBalance.toFixed(2)} (deducted $${amount.toFixed(2)})`);
  return result;
};

module.exports = mongoose.model('TradingStats', tradingStatsSchema);

