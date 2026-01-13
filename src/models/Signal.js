const mongoose = require('mongoose');

const candleSchema = new mongoose.Schema({
  slug: { type: String, required: true },
  color: { type: String, enum: ['green', 'red', 'unknown'], required: true },
  source: { type: String },
  prices: {
    start: { type: Number },
    current: { type: Number },
  },
  resolved: { type: Boolean, default: false },
  endTime: { type: String },
}, { _id: false });

const signalSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['eth', 'btc'],
    required: true,
  },
  candleCount: {
    type: Number,
    enum: [2, 3],
    required: true,
  },
  color: {
    type: String,
    enum: ['green', 'red'],
    required: true,
  },
  marketSlug: {
    type: String,
    required: true,
    index: true,
  },
  nextMarketSlug: { type: String },
  nextMarketUrl: { type: String },
  candles: [candleSchema],
  status: {
    type: String,
    enum: ['detected', 'sent', 'invalid', 'expired'],
    default: 'detected',
  },
  sentTo: [{ type: Number }],
  detectedAt: {
    type: Date,
    default: Date.now,
  },
  timeToEnd: { type: Number },
  invalidReason: { type: String },
});

signalSchema.index({ status: 1, detectedAt: -1 });
signalSchema.index({ type: 1, marketSlug: 1, candleCount: 1 }, { unique: true });

module.exports = mongoose.model('Signal', signalSchema);

