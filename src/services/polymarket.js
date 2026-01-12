const axios = require('axios');
const config = require('../config');

// Gamma API - для получения token IDs и базовой инфы
const gamma = axios.create({
  baseURL: config.polymarket.gammaApiUrl,
  timeout: 10000,
});

// CLOB API - для актуальных цен
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
 * Получить информацию о рынке из Gamma API (tokenIds, conditionId)
 */
async function fetchMarketInfo(slug) {
  try {
    const { data } = await gamma.get(`/events/slug/${slug}`);
    if (!data || !data.markets?.[0]) return null;
    
    const market = data.markets[0];
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const outcomes = JSON.parse(market.outcomes || '[]');
    
    // Находим индекс Up токена
    const upIndex = outcomes.findIndex(o => /up/i.test(o));
    const downIndex = outcomes.findIndex(o => /down/i.test(o));
    
    return {
      slug,
      conditionId: market.conditionId,
      upTokenId: tokenIds[upIndex] || tokenIds[0],
      downTokenId: tokenIds[downIndex] || tokenIds[1],
      active: market.active,
      closed: market.closed,
    };
  } catch (error) {
    if (error.response?.status === 404 || error.response?.status === 422) {
      return null;
    }
    throw error;
  }
}

/**
 * Получить начальную цену рынка (при открытии)
 */
async function getStartPrice(tokenId) {
  try {
    const { data } = await clob.get('/prices-history', {
      params: {
        market: tokenId,
        interval: 'max',
        fidelity: 60,
      },
    });
    
    if (data.history && data.history.length > 0) {
      return parseFloat(data.history[0].p);
    }
    return null;
  } catch (error) {
    console.error('Error fetching start price:', error.message);
    return null;
  }
}

/**
 * Получить текущую цену токена (или последнюю из истории для закрытых рынков)
 */
async function getCurrentPrice(tokenId) {
  try {
    const { data } = await clob.get('/price', {
      params: {
        token_id: tokenId,
        side: 'buy',
      },
    });
    return parseFloat(data.price);
  } catch (error) {
    // Для закрытых рынков /price может вернуть 404
    // Берём последнюю цену из истории
    if (error.response?.status === 404) {
      return await getLastPriceFromHistory(tokenId);
    }
    console.error('Error fetching current price:', error.message);
    return null;
  }
}

/**
 * Получить последнюю цену из истории (для закрытых рынков)
 */
async function getLastPriceFromHistory(tokenId) {
  try {
    const { data } = await clob.get('/prices-history', {
      params: {
        market: tokenId,
        interval: 'max',
        fidelity: 60,
      },
    });
    
    if (data.history && data.history.length > 0) {
      // Последний элемент = последняя цена
      return parseFloat(data.history[data.history.length - 1].p);
    }
    return null;
  } catch (error) {
    console.error('Error fetching last price from history:', error.message);
    return null;
  }
}

/**
 * Получить цену Up токена из markets endpoint
 */
async function getUpPriceFromMarkets(conditionId) {
  try {
    const { data } = await clob.get(`/markets/${conditionId}`);
    const upToken = data.tokens?.find(t => /up/i.test(t.outcome));
    return {
      price: parseFloat(upToken?.price || 0),
      winner: upToken?.winner === true ? 'up' : (data.tokens?.find(t => /down/i.test(t.outcome))?.winner === true ? 'down' : null),
      closed: data.closed,
    };
  } catch {
    return null;
  }
}

/**
 * Определить цвет рынка (GREEN/RED)
 * Логика: текущая цена Up >= начальной цены Up → GREEN
 */
async function getMarketColor(slug) {
  const marketInfo = await fetchMarketInfo(slug);
  
  if (!marketInfo || !marketInfo.upTokenId) {
    return { color: 'unknown', source: 'no_market_info', prices: { start: 0, current: 0 } };
  }

  // Получаем начальную цену
  const startPrice = await getStartPrice(marketInfo.upTokenId);
  if (startPrice === null) {
    return { color: 'unknown', source: 'no_start_price', prices: { start: null, current: null } };
  }

  // Проверяем winner и текущую цену через markets endpoint
  const marketData = await getUpPriceFromMarkets(marketInfo.conditionId);
  
  // Если есть официальный winner - рынок зарезолвлен
  if (marketData?.winner === 'up') {
    return { color: 'green', source: 'winner', resolved: true, prices: { start: startPrice, current: 1 } };
  }
  if (marketData?.winner === 'down') {
    return { color: 'red', source: 'winner', resolved: true, prices: { start: startPrice, current: 0 } };
  }

  // Получаем текущую цену - сначала пробуем live endpoint
  let currentPrice = await getCurrentPrice(marketInfo.upTokenId);
  
  // Если live недоступен, берём из markets
  if (currentPrice === null && marketData) {
    currentPrice = marketData.price;
  }

  if (currentPrice === null) {
    return { color: 'unknown', source: 'no_current_price', prices: { start: startPrice, current: null } };
  }

  const prices = { start: startPrice, current: currentPrice };
  const isClosed = marketData?.closed === true;

  // Если рынок ЗАКРЫТ но НЕ резолвнут и цена между 0.4 и 0.6 - неопределённый результат
  // (для активных рынков это нормально, проблема только для закрытых)
  if (isClosed && currentPrice >= 0.4 && currentPrice <= 0.6) {
    return { color: 'unknown', source: 'price_uncertain', resolved: false, prices };
  }

  // Основная логика: сравниваем текущую цену с начальной
  if (currentPrice >= startPrice) {
    return { color: 'green', source: 'price_vs_start', resolved: false, prices };
  } else {
    return { color: 'red', source: 'price_vs_start', resolved: false, prices };
  }
}

/**
 * Проверить активен ли рынок
 */
async function isMarketActive(slug) {
  const marketInfo = await fetchMarketInfo(slug);
  if (!marketInfo) return false;
  
  try {
    const { data } = await clob.get(`/markets/${marketInfo.conditionId}`);
    return data.active === true && data.accepting_orders === true && data.closed === false;
  } catch {
    return false;
  }
}

/**
 * Получить контекст 15-минутных рынков (текущий + 2 предыдущих)
 */
async function get15mContext(baseSlug) {
  const slugs = getPrev15mSlugs(baseSlug);
  
  // Получаем цвета всех трёх рынков
  const [currentColor, prev1Color, prev2Color] = await Promise.all([
    getMarketColor(slugs.current),
    getMarketColor(slugs.prev1),
    getMarketColor(slugs.prev2),
  ]);

  // Проверяем активность текущего рынка
  const active = await isMarketActive(slugs.current);

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

/**
 * Форматирование timestamp в время ET (Eastern Time)
 * Polymarket использует ET для отображения времени рынков
 */
function formatTimeET(timestamp) {
  const date = new Date(timestamp * 1000);
  // ET = UTC - 5 часов (EST) или UTC - 4 (EDT летом)
  // Для простоты используем -5
  const etDate = new Date(date.getTime() - 5 * 60 * 60 * 1000);
  const hours = etDate.getUTCHours();
  const minutes = etDate.getUTCMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes.toString().padStart(2, '0')}${ampm}`;
}

/**
 * Получить время начала рынка из slug
 */
function getTimestampFromSlug(slug) {
  const match = slug.match(/-(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

module.exports = {
  get15mContext,
  getMarketUrl,
  formatTimeToEnd,
  formatTimeET,
  getTimestampFromSlug,
  getCurrentIntervalStart,
};
