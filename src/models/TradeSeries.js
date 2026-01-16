const mongoose = require('mongoose');

// Событие в серии
const eventSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  type: { 
    type: String, 
    enum: [
      'series_opened',    // Серия открыта по сигналу
      'buy',              // Купили ставку
      'sell',             // Продали позицию
      'sell_hedge',       // Продали хедж (рынок вернулся в наш цвет)
      'signal_cancelled', // Сигнал отменился (рынок изменил цвет)
      'waiting_market',   // Ждём начало рынка
      'market_active',    // Рынок стал активным
      'market_won',       // Рынок закрылся в наш цвет
      'market_lost',      // Рынок закрылся не в наш цвет
      'series_won',       // Серия завершена победой
      'series_lost',      // Серия завершена проигрышем (4 шага)
      'series_cancelled', // Серия отменена
      'insufficient_balance', // Недостаточно средств
      'price_error',      // Не удалось получить цену
      'hedge_bought',     // Куплен хедж
      'hedge_sold',       // Продан хедж
      'order_book',       // Информация об order book
      'validation_started', // Начата валидация рынка
      'validation_rejected', // Валидация не пройдена
    ],
    required: true 
  },
  step: { type: Number },           // Текущий шаг (1-4)
  marketSlug: { type: String },     // Рынок
  amount: { type: Number },         // Сумма
  marketColor: { type: String },    // Цвет рынка в момент события
  pnl: { type: Number },            // P&L этого события
  message: { type: String },        // Описание
}, { _id: false });

// Серия торговли
const tradeSeriesSchema = new mongoose.Schema({
  botId: { type: String, default: 'bot1', required: true }, // ID бота (для поддержки нескольких ботов)
  asset: { type: String, enum: ['eth', 'btc'], required: true },
  signalMarketSlug: { type: String }, // Рынок где был сигнал (для отслеживания отмены)
  signalColor: { type: String, enum: ['green', 'red', 'unknown'], required: true },
  betColor: { type: String, enum: ['green', 'red', 'unknown'], required: true },
  
  // Валидация покупки
  validationState: {
    type: String,
    enum: ['validating', 'validated', 'rejected'],
    default: null,
  },
  validationHistory: [{
    timestamp: Date,
    price: Number,
    matches: Boolean,  // соответствует ли цена сигналу
    symbol: String,   // '+' или '-'
    checkOutcome: String, // Какой исход проверяем: 'up' или 'down'
    orderBook: {     // Данные order book (опционально)
      imbalance: Number,  // imbalance из analyzeOrderBook
      bidsTotal: Number,
      asksTotal: Number,
    },
  }],
  validationEventIndex: {
    type: Number,
    default: null,
  },
  validationMarketSlug: String,  // Рынок который валидируем (рынок где сигнал)
  lastValidationCheck: Date,     // Время последней проверки
  lastStabilityResult: {         // Последний результат проверки стабильности
    stable: Boolean,
    reason: String,
    changePercent: Number,
  },
  
  // Валидация хеджа
  hedgeValidationState: {
    type: String,
    enum: ['validating', 'validated', 'rejected'],
    default: null,
  },
  hedgeValidationHistory: [{
    timestamp: Date,
    price: Number,
    matches: Boolean,  // соответствует ли цена сигналу
    symbol: String,     // '+' или '-'
    checkOutcome: String, // Какой исход проверяем: 'up' или 'down'
    orderBook: {     // Данные order book (опционально)
      imbalance: Number,  // imbalance из analyzeOrderBook
      bidsTotal: Number,
      asksTotal: Number,
    },
  }],
  hedgeValidationEventIndex: {
    type: Number,
    default: null,
  },
  hedgeValidationMarketSlug: String,  // Рынок который валидируем (следующий рынок)
  hedgeLastValidationCheck: Date,      // Время последней проверки
  lastHedgeStabilityResult: {         // Последний результат проверки стабильности для хеджа
    stable: Boolean,
    reason: String,
    changePercent: Number,
  },
  
  status: { 
    type: String, 
    enum: ['active', 'won', 'lost', 'cancelled', 'cooldown'], 
    default: 'active' 
  },
  
  // Текущее состояние
  currentStep: { type: Number, default: 1 },
  currentMarketSlug: { type: String },
  marketState: { 
    type: String, 
    enum: ['waiting', 'active', 'closed'],
    default: 'waiting'
  },
  
  // Ранняя покупка следующего шага (хеджирование)
  nextStepBought: { type: Boolean, default: false },
  nextMarketSlug: { type: String },
  
  // Финансы
  totalInvested: { type: Number, default: 0 },
  totalCommission: { type: Number, default: 0 },
  totalPnL: { type: Number, default: 0 },
  
  // Позиции по шагам
  positions: [{
    step: Number,
    marketSlug: String,      // Рынок где была куплена позиция
    tokenId: String,         // ID токена (для отслеживания позиции)
    amount: Number,
    price: Number,
    shares: Number,
    commission: Number,
    status: { type: String, enum: ['active', 'won', 'lost', 'sold'], default: 'active' },
  }],
  
  // Таймлайн событий
  events: [eventSchema],
  
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
});

tradeSeriesSchema.index({ botId: 1, status: 1 });
tradeSeriesSchema.index({ botId: 1, asset: 1, startedAt: -1 });

// Добавить событие
tradeSeriesSchema.methods.addEvent = function(type, data = {}) {
  this.events.push({
    timestamp: new Date(),
    type,
    step: data.step || this.currentStep,
    marketSlug: data.marketSlug || this.currentMarketSlug,
    amount: data.amount,
    marketColor: data.marketColor,
    pnl: data.pnl,
    message: data.message,
  });
};

// Получить последнее событие
tradeSeriesSchema.methods.getLastEvent = function() {
  return this.events[this.events.length - 1];
};

module.exports = mongoose.model('TradeSeries', tradeSeriesSchema);

