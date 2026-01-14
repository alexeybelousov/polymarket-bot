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
const { TRADING_CONFIGS } = require('../services/tradingEmulator');

const isBinance = config.dataSource === 'binance';
const dataProvider = isBinance ? binance : polymarket;

function createServer(port = 3000, tradingEmulators = null) {
  // Поддерживаем как один бот (для обратной совместимости), так и массив ботов
  const emulators = Array.isArray(tradingEmulators) 
    ? tradingEmulators 
    : tradingEmulators ? [tradingEmulators] : [];
  const app = express();

  app.use('/static', express.static(path.join(__dirname, 'public')));

  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  });

  app.get('/monitor', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'monitor.html'));
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
      const botId = req.query.botId || 'bot1'; // По умолчанию bot1 для обратной совместимости
      const stats = await TradingStats.getStats(botId);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // API для получения конфигов ботов
  app.get('/api/trading/bots', async (req, res) => {
    try {
      const bots = Object.entries(TRADING_CONFIGS).map(([botId, config]) => ({
        botId,
        name: config.name || `Бот ${botId}`,
        config: {
          firstBetPercent: config.firstBetPercent,
          signalType: config.signalType,
          maxSteps: config.maxSteps,
          baseDeposit: config.baseDeposit,
          maxPrice: config.maxPrice,
        },
      }));
      res.json(bots);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Активные серии торговли
  app.get('/api/trading/series/active', async (req, res) => {
    try {
      const botId = req.query.botId; // Опционально - если не указан, возвращаем все
      const query = { status: 'active' };
      if (botId) query.botId = botId;
      const series = await TradeSeries.find(query).lean();
      res.json(series);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // История серий
  app.get('/api/trading/series/history', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 10;
      const botId = req.query.botId; // Опционально
      const query = { status: { $ne: 'active' } };
      if (botId) query.botId = botId;
      const series = await TradeSeries.find(query)
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
      const botId = req.query.botId; // Опционально - если не указан, возвращаем все боты
      const query = {};
      if (botId) query.botId = botId;
      const series = await TradeSeries.find(query)
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
      const botId = req.query.botId; // Опционально

      const query = {};
      if (type) query.type = type;
      
      // Если выбран бот, показываем его trade логи И все detect сигналы (они независимы от ботов)
      if (botId) {
        if (action === 'detect') {
          // Для detect сигналов botId не применяется (они независимы от ботов)
          query.action = 'detect';
        } else if (action === 'trade') {
          // Для trade логов показываем только выбранного бота
          query.action = 'trade';
          query.botId = botId;
        } else {
          // Если action не указан, показываем trade логи бота + все detect сигналы
          query.$or = [
            { botId: botId, action: 'trade' },
            { action: 'detect' },
          ];
        }
      } else {
        // Если бот не выбран, применяем обычный фильтр по action
        if (action) query.action = action;
      }

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
