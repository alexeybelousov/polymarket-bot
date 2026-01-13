const mongoose = require('mongoose');

const signalLogSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    default: Date.now,
  },
  botId: {
    type: String,
    default: 'bot1', // Для обратной совместимости
  },
  type: {
    type: String,
    enum: ['eth', 'btc', 'unknown'],
    required: true,
  },
  marketSlug: {
    type: String,
    default: 'unknown',
  },
  action: {
    type: String,
    enum: ['check', 'skip', 'detect', 'send', 'error', 'trade'],
    required: true,
  },
  reason: { type: String },
  data: { type: mongoose.Schema.Types.Mixed },
});

signalLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
signalLogSchema.index({ botId: 1, timestamp: -1 });

module.exports = mongoose.model('SignalLog', signalLogSchema);

