const mongoose = require('mongoose');

const signalLogSchema = new mongoose.Schema({
  timestamp: {
    type: Date,
    default: Date.now,
    index: true,
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

module.exports = mongoose.model('SignalLog', signalLogSchema);

