const axios = require('axios');

// Binance endpoints (попробуем несколько если один блокирует)
const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision/api/v3',  // Public data API (без геоблокировки)
  'https://api.binance.com/api/v3',           // Global
];

let workingEndpoint = null; // Запоминаем рабочий endpoint
let lastEndpointCheck = 0;
const ENDPOINT_RECHECK_INTERVAL = 60000; // Перепроверять endpoints раз в минуту

// Кеш для данных
const cache = {
  eth: { data: null, timestamp: 0 },
  btc: { data: null, timestamp: 0 },
};
const CACHE_TTL = 2000; // 2 секунды

const SYMBOLS = {
  eth: 'ETHUSDT',
  btc: 'BTCUSDT',
};

/**
 * Получить 15-минутные свечи с Binance
 */
async function getKlines(symbol, limit = 4) {
  const now = Date.now();
  
  // Если есть рабочий endpoint и он недавно проверялся - используем его
  if (workingEndpoint && (now - lastEndpointCheck) < ENDPOINT_RECHECK_INTERVAL) {
    const url = `${workingEndpoint}/klines?symbol=${symbol}&interval=15m&limit=${limit}`;
    try {
      const { data } = await axios.get(url, { timeout: 3000 });
      return parseKlines(data);
    } catch (error) {
      // Endpoint перестал работать, сбрасываем
      console.log(`[Binance] Endpoint ${workingEndpoint} failed, will retry others`);
      workingEndpoint = null;
    }
  }
  
  // Пробуем все endpoints
  let lastError;
  for (const endpoint of BINANCE_ENDPOINTS) {
    const url = `${endpoint}/klines?symbol=${symbol}&interval=15m&limit=${limit}`;
    
    try {
      const { data } = await axios.get(url, { timeout: 2000 }); // Быстрый таймаут
      
      // Запоминаем рабочий endpoint
      if (workingEndpoint !== endpoint) {
        console.log(`[Binance] Using endpoint: ${endpoint}`);
        workingEndpoint = endpoint;
        lastEndpointCheck = now;
      }
      
      return parseKlines(data);
    } catch (error) {
      lastError = error;
    }
  }
  
  throw lastError || new Error('All Binance endpoints failed');
}

function parseKlines(data) {
  return data.map(k => ({
    openTime: k[0],
    closeTime: k[6],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    color: parseFloat(k[4]) >= parseFloat(k[1]) ? 'green' : 'red',
  }));
}

/**
 * Получить контекст для 15-минутных свечей (аналог polymarket.get15mContext)
 */
async function get15mContext(type) {
  const symbol = SYMBOLS[type];
  if (!symbol) throw new Error(`Unknown type: ${type}`);
  
  // Проверяем кеш
  const now = Date.now();
  const cached = cache[type];
  if (cached.data && (now - cached.timestamp) < CACHE_TTL) {
    // Обновляем только timeToEnd
    const candleEndTime = cached.data.current.marketInfo.endDate;
    cached.data.current.timeToEnd = Math.max(0, Math.floor((new Date(candleEndTime).getTime() - now) / 1000));
    return cached.data;
  }
  
  const candles = await getKlines(symbol, 4);
  
  // candles[0] = oldest, candles[3] = current (still forming)
  const prev2 = candles[0];
  const prev1 = candles[1];
  const prev0 = candles[2]; // Last closed candle
  const current = candles[3]; // Current forming candle
  
  const candleEndTime = current.closeTime;
  const timeToEnd = Math.max(0, Math.floor((candleEndTime - now) / 1000));
  
  // Format time for display (ET timezone)
  const formatTime = (ts) => {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/New_York',
    });
  };
  
  const makeCandle = (c, isResolved) => ({
    color: c.color,
    source: 'binance',
    resolved: isResolved,
    prices: {
      start: c.open,
      current: c.close,
    },
    marketInfo: {
      slug: `binance-${symbol.toLowerCase()}-${c.openTime}`,
      endDate: new Date(c.closeTime).toISOString(),
    },
  });
  
  const result = {
    slugs: {
      prev2: `binance-${symbol.toLowerCase()}-${prev1.openTime}`,
      prev1: `binance-${symbol.toLowerCase()}-${prev0.openTime}`,
      current: `binance-${symbol.toLowerCase()}-${current.openTime}`,
      next: `binance-${symbol.toLowerCase()}-${current.closeTime + 1}`, // +1 чтобы совпал с openTime следующей свечи
    },
    previous: [
      makeCandle(prev1, true),  // P2 - closed
      makeCandle(prev0, true),  // P1 - closed
    ],
    current: {
      ...makeCandle(current, false),
      active: true,
      timeToEnd,
    },
  };
  
  // Сохраняем в кеш
  cache[type] = { data: result, timestamp: Date.now() };
  
  return result;
}

/**
 * Получить URL рынка (для Binance просто ссылка на TradingView)
 */
function getMarketUrl(slug) {
  if (slug.includes('ethusdt')) {
    return 'https://www.tradingview.com/chart/?symbol=BINANCE:ETHUSDT';
  }
  if (slug.includes('btcusdt')) {
    return 'https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT';
  }
  return 'https://www.binance.com';
}

/**
 * Получить timestamp из slug
 */
function getTimestampFromSlug(slug) {
  const match = slug.match(/-(\d+)$/);
  return match ? parseInt(match[1]) / 1000 : Date.now() / 1000;
}

/**
 * Форматировать время в ET
 */
function formatTimeET(timestampSec) {
  return new Date(timestampSec * 1000).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
}

/**
 * Форматировать время до конца
 */
function formatTimeToEnd(seconds) {
  if (seconds <= 0) return 'закрыт';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) {
    return `${mins} мин ${secs} сек`;
  }
  return `${secs} сек`;
}

module.exports = {
  get15mContext,
  getMarketUrl,
  getTimestampFromSlug,
  formatTimeET,
  formatTimeToEnd,
  SYMBOLS,
};

