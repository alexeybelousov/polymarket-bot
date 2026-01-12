const axios = require('axios');
const config = require('../config');

// Gamma API - для получения conditionId и базовой инфы
const gamma = axios.create({
  baseURL: config.polymarket.gammaApiUrl,
  timeout: 10000,
});

// CLOB API - для актуальных цен в реальном времени
const clob = axios.create({
  baseURL: 'https://clob.polymarket.com',
  timeout: 10000,
});

/**
 * Получить текущий timestamp НАЧАЛА 15-минутного интервала
 */
function getCurrentIntervalStart() {
  const now = Math.floor(Date.now() / 1000);
  const interval = 900;
  return Math.floor(now / interval) * interval;
}

/**
 * Получить slug'и: текущий, -15 мин, -30 мин
 */
function getPrev15mSlugs(baseSlug) {
  const ts = getCurrentIntervalStart();
  const step = 900;
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
 * Получить базовую инфу о рынке из Gamma API (conditionId, tokenIds)
 */
async function fetchMarketInfo(slug) {
  try {
    const { data } = await gamma.get(`/events/slug/${slug}`);
    if (!data || !data.markets?.[0]) return null;
    
    const market = data.markets[0];
    return {
      slug,
      conditionId: market.conditionId,
      tokenIds: JSON.parse(market.clobTokenIds || '[]'),
    };
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 422) {
      return null;
    }
    throw error;
  }
}

/**
 * Получить актуальные цены из CLOB API
 * @returns {{ color: string, source: string, prices: { up: number, down: number }, winner?: string }}
 */
async function fetchClobPrices(conditionId) {
  try {
    const { data } = await clob.get(`/markets/${conditionId}`);
    
    if (!data || !data.tokens || data.tokens.length < 2) {
      return { color: 'unknown', source: 'clob_no_tokens', prices: { up: 0, down: 0 } };
    }

    // Находим Up и Down токены
    const upToken = data.tokens.find(t => /up/i.test(t.outcome));
    const downToken = data.tokens.find(t => /down/i.test(t.outcome));

    if (!upToken || !downToken) {
      return { color: 'unknown', source: 'clob_no_outcomes', prices: { up: 0, down: 0 } };
    }

    const pUp = parseFloat(upToken.price) || 0;
    const pDown = parseFloat(downToken.price) || 0;
    const priceInfo = { up: pUp, down: pDown };

    // Проверяем победителя (для резолвнутых рынков)
    if (upToken.winner === true) {
      return { color: 'green', source: 'clob_winner', prices: priceInfo, winner: 'Up' };
    }
    if (downToken.winner === true) {
      return { color: 'red', source: 'clob_winner', prices: priceInfo, winner: 'Down' };
    }

    // Для не резолвнутых - по цене
    if (pUp > 0.9) return { color: 'green', source: 'clob_price_resolved', prices: priceInfo };
    if (pDown > 0.9) return { color: 'red', source: 'clob_price_resolved', prices: priceInfo };

    // По лидирующей цене
    if (pUp > pDown) return { color: 'green', source: 'clob_price', prices: priceInfo };
    if (pDown > pUp) return { color: 'red', source: 'clob_price', prices: priceInfo };

    return { color: 'neutral', source: 'clob_prices_equal', prices: priceInfo };

  } catch (error) {
    console.error(`CLOB API error for ${conditionId}:`, error.message);
    return { color: 'unknown', source: 'clob_error', prices: { up: 0, down: 0 } };
  }
}

/**
 * Получить цвет рынка (с fallback на Gamma если CLOB недоступен)
 */
async function getMarketColor(slug) {
  // Сначала получаем conditionId из Gamma
  const marketInfo = await fetchMarketInfo(slug);
  
  if (!marketInfo || !marketInfo.conditionId) {
    return { color: 'unknown', source: 'no_market_info', prices: { up: 0, down: 0 } };
  }

  // Получаем актуальные цены из CLOB
  const clobResult = await fetchClobPrices(marketInfo.conditionId);
  return clobResult;
}

/**
 * Проверить активен ли рынок (принимает ордера)
 */
async function isMarketActive(conditionId) {
  try {
    const { data } = await clob.get(`/markets/${conditionId}`);
    return data.active === true && data.accepting_orders === true && data.closed === false;
  } catch {
    return false;
  }
}

/**
 * Получить контекст 15-минутных рынков (текущий + 2 предыдущих)
 * Использует CLOB API для актуальных цен!
 */
async function get15mContext(baseSlug) {
  const slugs = getPrev15mSlugs(baseSlug);
  
  // Получаем цвета всех трёх рынков через CLOB API
  const [currentColor, prev1Color, prev2Color] = await Promise.all([
    getMarketColor(slugs.current),
    getMarketColor(slugs.prev1),
    getMarketColor(slugs.prev2),
  ]);

  // Проверяем активность текущего рынка
  const currentMarketInfo = await fetchMarketInfo(slugs.current);
  const active = currentMarketInfo?.conditionId 
    ? await isMarketActive(currentMarketInfo.conditionId)
    : false;

  // Время до конца рынка в секундах
  const now = Math.floor(Date.now() / 1000);
  const timeToEnd = slugs.currentIntervalEnd - now;

  return {
    slugs,
    previous: [
      { slug: slugs.prev2, ...prev2Color },
      { slug: slugs.prev1, ...prev1Color },
    ],
    current: {
      slug: slugs.current,
      active,
      ...currentColor,
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
