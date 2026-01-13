const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: {
    type: Number,
    required: true,
    unique: true,
    index: true,
  },
  username: {
    type: String,
    default: null,
  },
  firstName: {
    type: String,
    default: null,
  },
  signals: {
    eth3candles: {
      type: Boolean,
      default: false,
    },
    eth2candles: {
      type: Boolean,
      default: false,
    },
    btc3candles: {
      type: Boolean,
      default: false,
    },
    btc2candles: {
      type: Boolean,
      default: false,
    },
    tradingNotifications: {
      type: Boolean,
      default: false,
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

userSchema.pre('save', function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model('User', userSchema);
