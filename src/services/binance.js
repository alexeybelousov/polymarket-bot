const axios = require('axios');

const BINANCE_API = 'https://api.binance.com/api/v3';

const SYMBOLS = {
  eth: 'ETHUSDT',
  btc: 'BTCUSDT',
};

/**
 * Получить 15-минутные свечи с Binance
 */
async function getKlines(symbol, limit = 4) {
  const url = `${BINANCE_API}/klines?symbol=${symbol}&interval=15m&limit=${limit}`;
  const { data } = await axios.get(url);
  
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
  
  const candles = await getKlines(symbol, 4);
  
  // candles[0] = oldest, candles[3] = current (still forming)
  const prev2 = candles[0];
  const prev1 = candles[1];
  const prev0 = candles[2]; // Last closed candle
  const current = candles[3]; // Current forming candle
  
  const now = Date.now();
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
  
  return {
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

