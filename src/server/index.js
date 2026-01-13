const express = require('express');
const path = require('path');
const Signal = require('../models/Signal');
const SignalLog = require('../models/SignalLog');
const User = require('../models/User');
const TradeSeries = require('../models/TradeSeries');
const TradingStats = require('../models/TradingStats');
const polymarket = require('../services/polymarket');
const binance = require('../services/binance');
const config = require('../config');

const isBinance = config.dataSource === 'binance';
const dataProvider = isBinance ? binance : polymarket;

function createServer(port = 3000, tradingEmulator = null) {
  const app = express();

  app.use('/static', express.static(path.join(__dirname, 'public')));

  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  });

  app.get('/logs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'logs.html'));
  });

  app.get('/api/markets/live', async (req, res) => {
    try {
      const [ethContext, btcContext] = await Promise.all([
        isBinance ? dataProvider.get15mContext('eth') : dataProvider.get15mContext(config.polymarket.markets.eth),
        isBinance ? dataProvider.get15mContext('btc') : dataProvider.get15mContext(config.polymarket.markets.btc),
      ]);

      const formatCandle = (data) => {
        const endTime = data.marketInfo?.endDate 
          ? new Date(data.marketInfo.endDate).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })
          : '';
        return {
          slug: data.marketInfo?.slug || '',
          endTime,
          color: data.color,
          source: data.source,
          resolved: data.resolved || false,
          prices: data.prices,
        };
      };

      res.json({
        source: config.dataSource,
        eth: {
          current: formatCandle(ethContext.current),
          prev1: formatCandle(ethContext.previous[1]),
          prev2: formatCandle(ethContext.previous[0]),
          timeToEnd: ethContext.current.timeToEnd,
          active: ethContext.current.active,
        },
        btc: {
          current: formatCandle(btcContext.current),
          prev1: formatCandle(btcContext.previous[1]),
          prev2: formatCandle(btcContext.previous[0]),
          timeToEnd: btcContext.current.timeToEnd,
          active: btcContext.current.active,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // API для торговли
  app.get('/api/trading/stats', async (req, res) => {
    try {
      const stats = await TradingStats.getStats();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Активные серии торговли
  app.get('/api/trading/series/active', async (req, res) => {
    try {
      const series = await TradeSeries.find({ status: 'active' }).lean();
      res.json(series);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // История серий
  app.get('/api/trading/series/history', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const series = await TradeSeries.find({ status: { $ne: 'active' } })
        .sort({ endedAt: -1 })
        .limit(limit)
        .lean();
      res.json(series);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Все серии (для дашборда)
  app.get('/api/trading/series', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const series = await TradeSeries.find()
        .sort({ startedAt: -1 })
        .limit(limit)
        .lean();
      res.json(series);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/logs', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const type = req.query.type;
      const action = req.query.action;

      const query = {};
      if (type) query.type = type;
      if (action) query.action = action;

      const [logs, total] = await Promise.all([
        SignalLog.find(query).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        SignalLog.countDocuments(query),
      ]);

      res.json({ logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  const server = app.listen(port, () => {
    console.log(`🌐 Dashboard: http://localhost:${port}/dashboard`);
  });

  return server;
}

module.exports = { createServer };
