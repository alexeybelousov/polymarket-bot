const axios = require('axios');
const config = require('../config');

const gamma = axios.create({
  baseURL: config.polymarket.gammaApiUrl,
  timeout: 10000,
});

/**
 * Получить текущий timestamp НАЧАЛА 15-минутного интервала
 * Slug рынка содержит start time, а не end time!
 */
function getCurrentIntervalStart() {
  const now = Math.floor(Date.now() / 1000);
  const interval = 900; // 15 минут в секундах
  return Math.floor(now / interval) * interval;
}

/**
 * Разобрать slug формата "eth-updown-15m-1768168800"
 */
function parse15mSlug(slug) {
  const parts = slug.split('-');
  const tsStr = parts.pop();
  const base = parts.join('-');
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) {
    throw new Error(`Неверный slug: ${slug}`);
  }
  return { base, ts };
}

/**
 * Получить slug'и: текущий, -15 мин, -30 мин
 */
function getPrev15mSlugs(baseSlug) {
  const ts = getCurrentIntervalStart();
  const step = 900;

  // Время окончания текущего интервала (для расчёта timeToEnd)
  const currentIntervalEnd = ts + step;

  return {
    current: `${baseSlug}-${ts}`,
    prev1: `${baseSlug}-${ts - step}`,
    prev2: `${baseSlug}-${ts - 2 * step}`,
    currentTs: ts,
    currentIntervalEnd,
  };
}

/**
 * Забрать событие (event) по slug из Gamma API
 */
async function fetchEvent(slug) {
  try {
    const { data } = await gamma.get(`/events/slug/${slug}`);
    return data;
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 422) {
      return null;
    }
    throw error;
  }
}

/**
 * Проверка, активен ли рынок
 */
function isMarketActive(market) {
  if (!market) return false;

  if (typeof market.status === 'string') {
    return market.status === 'open';
  }
  if (typeof market.active === 'boolean') {
    if (market.closed === true) return false;
    return market.active;
  }

  if (market.resolution || market.winningOutcome) return false;

  return true;
}

/**
 * Парсинг outcomes/prices (могут быть строкой JSON или массивом)
 */
function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Цвет для уже РЕЗОЛВНУТОГО (или завершившегося) рынка
 * Примечание: Polymarket резолвит рынки не мгновенно, поэтому
 * для недавно закрытых рынков определяем цвет по текущим ценам
 * 
 * @returns {{ color: string, source: string, prices?: { up: number, down: number } }}
 */
function getResolvedMarketColor(eventJson) {
  if (!eventJson) return { color: 'unknown', source: 'no_data' };
  
  const market = eventJson.markets?.[0];
  if (!market) return { color: 'unknown', source: 'no_market' };

  // 1. Сначала проверяем официальный результат резолюции
  const win =
    market.winningOutcome ||
    market.resolution ||
    market.result ||
    null;

  if (typeof win === 'string') {
    const w = win.toLowerCase();
    if (/up|higher|above|yes/.test(w)) return { color: 'green', source: 'resolved', winningOutcome: win };
    if (/down|lower|below|no/.test(w)) return { color: 'red', source: 'resolved', winningOutcome: win };
  }

  // 2. Fallback: по ценам исходов
  const outcomes = parseArray(market.outcomes);
  const prices = parseArray(market.outcomePrices || market.prices);

  const idxUp = outcomes.findIndex(
    (o) => typeof o === 'string' && /up|higher|above|yes/i.test(o)
  );
  const idxDown = outcomes.findIndex(
    (o) => typeof o === 'string' && /down|lower|below|no/i.test(o)
  );

  if (idxUp === -1 || idxDown === -1) return { color: 'unknown', source: 'no_outcomes' };

  const pUp = parseFloat(prices[idxUp]) || 0;
  const pDown = parseFloat(prices[idxDown]) || 0;
  const priceInfo = { up: pUp, down: pDown };

  // Если цены близки к 1/0 - рынок резолвнут
  if (pUp > 0.9) return { color: 'green', source: 'price_resolved', prices: priceInfo };
  if (pDown > 0.9) return { color: 'red', source: 'price_resolved', prices: priceInfo };

  // 3. Если рынок закончился но ещё не резолвнут официально - 
  // определяем цвет по текущим ценам (кто лидирует)
  if (pUp > pDown) return { color: 'green', source: 'price_leading', prices: priceInfo };
  if (pDown > pUp) return { color: 'red', source: 'price_leading', prices: priceInfo };

  return { color: 'unknown', source: 'prices_equal', prices: priceInfo };
}

/**
 * Цвет для АКТИВНОГО рынка
 * 
 * @returns {{ color: string, source: string, prices?: { up: number, down: number } }}
 */
function getActiveMarketColor(eventJson) {
  if (!eventJson) return { color: 'neutral', source: 'no_data' };
  
  const market = eventJson.markets?.[0];
  if (!market) return { color: 'neutral', source: 'no_market' };

  const outcomes = parseArray(market.outcomes);
  const prices = parseArray(market.outcomePrices || market.prices);

  const idxUp = outcomes.findIndex(
    (o) => typeof o === 'string' && /up|higher|above|yes/i.test(o)
  );
  const idxDown = outcomes.findIndex(
    (o) => typeof o === 'string' && /down|lower|below|no/i.test(o)
  );

  if (idxUp === -1 || idxDown === -1) return { color: 'neutral', source: 'no_outcomes' };

  const pUp = parseFloat(prices[idxUp]) || 0;
  const pDown = parseFloat(prices[idxDown]) || 0;
  const priceInfo = { up: pUp, down: pDown };

  if (pUp > pDown) return { color: 'green', source: 'active_price', prices: priceInfo };
  if (pDown > pUp) return { color: 'red', source: 'active_price', prices: priceInfo };
  return { color: 'neutral', source: 'prices_equal', prices: priceInfo };
}

/**
 * Получить контекст 15-минутных рынков (текущий + 2 предыдущих)
 */
async function get15mContext(baseSlug) {
  const slugs = getPrev15mSlugs(baseSlug);
  
  const [current, prev1, prev2] = await Promise.all([
    fetchEvent(slugs.current),
    fetchEvent(slugs.prev1),
    fetchEvent(slugs.prev2),
  ]);

  const currentMarket = current?.markets?.[0];
  const active = isMarketActive(currentMarket);
  
  const currentColorInfo = active
    ? getActiveMarketColor(current)
    : getResolvedMarketColor(current);

  const prev1ColorInfo = getResolvedMarketColor(prev1);
  const prev2ColorInfo = getResolvedMarketColor(prev2);

  // Время до конца рынка в секундах
  const now = Math.floor(Date.now() / 1000);
  const timeToEnd = slugs.currentIntervalEnd - now;

  return {
    slugs,
    previous: [
      { slug: slugs.prev2, ...prev2ColorInfo },
      { slug: slugs.prev1, ...prev1ColorInfo },
    ],
    current: {
      slug: slugs.current,
      active,
      ...currentColorInfo,
      timeToEnd,
    },
  };
}

/**
 * Получить ссылку на рынок Polymarket
 */
function getMarketUrl(slug) {
  return `https://polymarket.com/event/${slug}`;
}

/**
 * Форматирование времени в минуты
 */
function formatTimeToEnd(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0) {
    return `${minutes} мин ${secs} сек`;
  }
  return `${secs} сек`;
}

module.exports = {
  get15mContext,
  getMarketUrl,
  formatTimeToEnd,
  getCurrentIntervalStart,
};

