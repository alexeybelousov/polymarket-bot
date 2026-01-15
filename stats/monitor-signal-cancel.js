const polymarket = require('../src/services/polymarket');

/**
 * Скрипт для мониторинга текущего рынка и анализа отмены сигнала
 * 
 * Сценарий:
 * 1. Получили сигнал 2 зеленых свечи
 * 2. НЕ покупаем сразу красный на следующий рынок
 * 3. Анализируем текущий рынок каждые 10 сек
 * 4. Пытаемся понять, будет ли отмена сигнала или нет
 * 5. Получаем order book для анализа
 */

// Параметры
const MONITOR_DURATION_MS = 5 * 60 * 1000; // 5 минут
const INTERVAL_MS = 10 * 1000; // 10 секунд
const STABILITY_CHECK_TIME_MS = 2 * 60 * 1000; // 2 минуты для проверки стабильности (чтобы набралось 12 записей)

// Параметры из командной строки
// node monitor-signal-cancel.js <market_slug> <signal_color>
// signal_color: 'green' или 'red'
const CURRENT_MARKET_SLUG = process.argv[2] || null;
const SIGNAL_COLOR = (process.argv[3] || 'green').toLowerCase(); // Сигнал был green или red

// Определяем обратный цвет для покупки
const BET_COLOR = SIGNAL_COLOR === 'green' ? 'red' : 'green';
const BET_OUTCOME = BET_COLOR === 'red' ? 'down' : 'up';
const MONITOR_OUTCOME = SIGNAL_COLOR === 'green' ? 'down' : 'up'; // Что мониторим на текущем рынке

// Функция для получения текущего рынка
function getCurrentMarketSlug(asset = 'eth') {
  if (CURRENT_MARKET_SLUG) {
    return CURRENT_MARKET_SLUG;
  }
  
  const now = Math.floor(Date.now() / 1000);
  const interval = 900; // 15 минут
  const currentStart = Math.floor(now / interval) * interval;
  
  return `${asset}-updown-15m-${currentStart}`;
}

// Функция для получения следующего рынка
function getNextMarketSlug(currentSlug, asset = 'eth') {
  if (!currentSlug) {
    const now = Math.floor(Date.now() / 1000);
    const interval = 900;
    const currentStart = Math.floor(now / interval) * interval;
    const nextStart = currentStart + interval;
    return `${asset}-updown-15m-${nextStart}`;
  }
  
  // Извлекаем timestamp из текущего slug
  const match = currentSlug.match(/-(\d+)$/);
  if (match) {
    const currentTimestamp = parseInt(match[1]);
    const nextTimestamp = currentTimestamp + 900; // +15 минут
    return currentSlug.replace(/-(\d+)$/, `-${nextTimestamp}`);
  }
  
  // Fallback
  const now = Math.floor(Date.now() / 1000);
  const interval = 900;
  const currentStart = Math.floor(now / interval) * interval;
  const nextStart = currentStart + interval;
  return `${asset}-updown-15m-${nextStart}`;
}

// Проверка стабильности рынка
function checkStability(history, signalColor) {
  if (history.length < 3) {
    return { stable: false, reason: 'Недостаточно данных' };
  }
  
  // Берем последние 12 записей (2 минуты при интервале 10 сек)
  const recent = history.slice(-12);
  if (recent.length < 3) {
    return { stable: false, reason: 'Недостаточно данных' };
  }
  
  const prices = recent.map(r => r.price).filter(p => p > 0);
  if (prices.length < 3) {
    return { stable: false, reason: 'Недостаточно цен' };
  }
  
  // ЛОГИКА: для обоих сигналов рост цены мониторинга = отмена сигнала
  // GREEN сигнал (ставим на RED/down): если цена DOWN растет → сигнал отменяется
  // RED сигнал (ставим на GREEN/up): если цена UP растет → сигнал отменяется
  // Для обоих: цена должна падать или быть стабильной на низком уровне → сигнал подтверждается
  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  const change = lastPrice - firstPrice;
  const changePercent = firstPrice > 0 ? (change / firstPrice) * 100 : 0;
  
  // Проверяем тренд (цена не должна расти)
  let trendOk = true;
  let hasGrowth = false;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > prices[i - 1] + 0.001) { // Небольшой порог для учета колебаний
      hasGrowth = true;
      // Если цена выросла более чем на 5% от начальной - это плохо (отмена сигнала)
      if (firstPrice > 0 && ((prices[i] - firstPrice) / firstPrice) * 100 > 5) {
        trendOk = false;
        break;
      }
    }
  }
  
  // Проверяем order book
  const lastOrderBook = recent[recent.length - 1]?.orderBook;
  let orderBookOk = false;
  let orderBookImbalance = 0;
  if (lastOrderBook) {
    // Используем imbalance из analyzeOrderBook: (asks - bids) / totalSize
    // Положительный = больше продавцов (asks > bids) → цена падает → хорошо для обоих сигналов
    // Отрицательный = больше покупателей (bids > asks) → цена растет → плохо для обоих сигналов
    orderBookImbalance = lastOrderBook.imbalance || 0;
    
    // Для ОБОИХ сигналов: больше продавцов = хорошо (цена падает, сигнал подтверждается)
    // imbalance > 0 означает больше продавцов
    if (orderBookImbalance > 0.5) {
      orderBookOk = true;
    } else if (orderBookImbalance > 0.1) {
      orderBookOk = true;
    }
  }
  
  // Если цена очень низкая (< $0.05) и стабильна - это может быть стабильно
  const isVeryLowPrice = lastPrice < 0.05;
  const isPriceStable = Math.abs(changePercent) < 5; // Изменение менее 5%
  
  // Если цена очень высокая (> $0.95) и стабильна - это тоже может быть стабильно
  const isVeryHighPrice = lastPrice > 0.95;
  
  // Стабильность определяется несколькими факторами:
  // Для ОБОИХ сигналов: рост цены мониторинга = отмена сигнала
  // Для ОБОИХ сигналов: падение цены или стабильность на низком уровне = подтверждение
  // Order book подтверждает (больше продавцов)
  // Цена стабильна (небольшие колебания)
  
  // ПРИОРИТЕТНАЯ ПРОВЕРКА: абсолютное значение цены
  // Для RED сигнала, если цена UP > 0.5, это означает отмену сигнала (рынок уже ушел в GREEN)
  if (signalColor === 'red' && lastPrice > 0.5) {
    return {
      stable: false,
      reason: `Цена UP ($${lastPrice.toFixed(4)}) выше $0.50 - рынок ушел в GREEN, сигнал RED отменяется`,
      changePercent,
    };
  }
  
  // Для GREEN сигнала, если цена DOWN > 0.5, это означает отмену сигнала (рынок уже ушел в RED)
  if (signalColor === 'green' && lastPrice > 0.5) {
    return {
      stable: false,
      reason: `Цена DOWN ($${lastPrice.toFixed(4)}) выше $0.50 - рынок ушел в RED, сигнал GREEN отменяется`,
      changePercent,
    };
  }
  
  // ПРИОРИТЕТ: Для очень низких цен (< $0.1) используем абсолютное изменение, а не процентное
  // Это должно быть ПЕРЕД проверкой на процентный рост, чтобы избежать ложных срабатываний
  if (isVeryLowPrice) {
    const absoluteChange = change;
    // Если цена выросла более чем на $0.05 или стала > $0.1 - это отмена
    if (absoluteChange > 0.05 || lastPrice > 0.1) {
      return {
        stable: false,
        reason: `Цена выросла с $${firstPrice.toFixed(4)} до $${lastPrice.toFixed(4)} (${changePercent.toFixed(2)}%) - возможна отмена`,
        changePercent,
      };
    }
    // Если цена очень низкая (< $0.1) и order book подтверждает (больше продавцов) - стабильно
    if (orderBookOk) {
      return {
        stable: true,
        reason: `Цена очень низкая ($${lastPrice.toFixed(4)}), order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%) - сигнал подтверждается`,
        changePercent,
      };
    }
  }
  
  // ВАЖНО: Если текущая цена низкая (< $0.3) и order book подтверждает - стабильно,
  // даже если был рост в середине окна (цена могла упасть обратно)
  if (lastPrice < 0.3 && orderBookOk) {
    return {
      stable: true,
      reason: `Цена низкая ($${lastPrice.toFixed(4)}), order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%) - сигнал подтверждается`,
      changePercent,
    };
  }
  
  // ВАЖНО: Если цена очень низкая (< $0.3) и падает значительно (> 10%) - стабильно,
  // даже если imbalance отрицательный (больше покупателей), т.к. падение цены - главный индикатор
  if (lastPrice < 0.3 && changePercent < -10) {
    return {
      stable: true,
      reason: `Цена низкая ($${lastPrice.toFixed(4)}) и падает на ${Math.abs(changePercent).toFixed(2)}% - сигнал подтверждается`,
      changePercent,
    };
  }
  
  // ВАЖНО: Если цена очень низкая (< $0.15) и остается низкой - стабильно,
  // даже если был небольшой рост (процентные изменения на низких ценах обманчивы)
  // Это должно быть ПЕРЕД проверкой на рост > 2%, чтобы избежать ложных срабатываний
  if (lastPrice < 0.15 && firstPrice < 0.15) {
    // Если и первая, и последняя цена очень низкие - это стабильно (цена остается в очень низком диапазоне)
    return {
      stable: true,
      reason: `Цена очень низкая ($${lastPrice.toFixed(4)}) и остается в низком диапазоне - сигнал подтверждается`,
      changePercent,
    };
  }
  
  // ВАЖНО: Если цена низкая (< $0.3) - стабильно, даже если был большой процентный рост
  // (процентные изменения на низких ценах обманчивы, главное - абсолютное значение цены)
  // Это должно быть ПЕРЕД проверкой на процентный рост, чтобы избежать ложных срабатываний
  if (lastPrice < 0.3) {
    return {
      stable: true,
      reason: `Цена низкая ($${lastPrice.toFixed(4)}) - сигнал подтверждается (процентные изменения на низких ценах не критичны)`,
      changePercent,
    };
  }
  
  // Если цена растет более чем на 10% - сигнал отменяется (только для цен > $0.3)
  // Для низких цен (< $0.3) эта проверка не применяется, т.к. процентные изменения обманчивы
  if (changePercent > 10 && lastPrice > 0.3) {
    return {
      stable: false,
      reason: `Цена выросла на ${changePercent.toFixed(2)}% - сигнал отменяется`,
      changePercent,
    };
  }
  
  // Если цена растет на 2-10% - возможна отмена (только для цен > $0.3, чтобы избежать ложных срабатываний на низких ценах)
  if (changePercent > 2 && lastPrice > 0.3) {
    return {
      stable: false,
      reason: `Цена выросла на ${changePercent.toFixed(2)}% - возможна отмена`,
      changePercent,
    };
  }
  
  // Для ОБОИХ сигналов: низкая цена = хорошо, высокая = плохо (рост = отмена)
  // Если цена очень низкая и стабильна, и order book подтверждает - стабильно
  if (isVeryLowPrice && isPriceStable && orderBookOk) {
    return {
      stable: true,
      reason: `Цена стабильна на низком уровне ($${lastPrice.toFixed(4)}), order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
      changePercent,
    };
  }
  
  // Если цена падает и order book подтверждает - стабильно
  if (changePercent < -1 && trendOk && orderBookOk) {
    return {
      stable: true,
      reason: `Цена упала на ${Math.abs(changePercent).toFixed(2)}%, order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
      changePercent,
    };
  }
  
  // Если цена падает значительно (> 10%) и order book подтверждает (больше продавцов) - стабильно
  if (changePercent < -10 && orderBookImbalance > 0.05) {
    return {
      stable: true,
      reason: `Цена упала на ${Math.abs(changePercent).toFixed(2)}%, order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
      changePercent,
    };
  }
  
  // Если цена падает умеренно (> 5%) и order book сильно подтверждает (больше продавцов) - стабильно
  if (changePercent < -5 && orderBookImbalance > 0.10) {
    return {
      stable: true,
      reason: `Цена упала на ${Math.abs(changePercent).toFixed(2)}%, order book сильно подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
      changePercent,
    };
  }
  
  // Если цена стабильна и order book сильно подтверждает (> 80% imbalance в пользу продавцов) - стабильно
  if (isPriceStable && orderBookImbalance > 0.8) {
    return {
      stable: true,
      reason: `Цена стабильна (изменение ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%), order book сильно подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
      changePercent,
    };
  }
  
  // Если цена стабильна и order book подтверждает (> 50% imbalance в пользу продавцов) - стабильно
  if (isPriceStable && orderBookOk) {
    return {
      stable: true,
      reason: `Цена стабильна (изменение ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%), order book подтверждает (imbalance: ${(orderBookImbalance * 100).toFixed(1)}%)`,
      changePercent,
    };
  }
  
  return {
    stable: false,
    reason: `Нестабильно: изменение ${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%, order book imbalance: ${(orderBookImbalance * 100).toFixed(1)}%`,
    changePercent,
  };
}

// Форматирование времени
function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Анализ order book
function analyzeOrderBook(bids, asks) {
  if (!bids || !asks || bids.length === 0 || asks.length === 0) {
    return null;
  }
  
  const bidsTotal = bids.reduce((sum, b) => sum + b.size, 0);
  const asksTotal = asks.reduce((sum, a) => sum + a.size, 0);
  const totalSize = bidsTotal + asksTotal;
  
  // Лучшие цены
  const bestBid = bids[0]?.price || 0;
  const bestAsk = asks[0]?.price || 0;
  const spread = bestAsk - bestBid;
  
  // Баланс order book
  const bidRatio = bidsTotal / totalSize;
  const askRatio = asksTotal / totalSize;
  
  // Анализ ликвидности на ключевых уровнях
  const nearBestBid = bids.slice(0, 5).reduce((sum, b) => sum + b.size, 0);
  const nearBestAsk = asks.slice(0, 5).reduce((sum, a) => sum + a.size, 0);
  
  return {
    bidsTotal,
    asksTotal,
    totalSize,
    bestBid,
    bestAsk,
    spread,
    bidRatio,
    askRatio,
    nearBestBid,
    nearBestAsk,
    imbalance: (asksTotal - bidsTotal) / totalSize, // Положительное = больше продавцов (asks > bids), отрицательное = больше покупателей (bids > asks)
  };
}

// Определение вероятности отмены сигнала
function estimateCancelProbability(priceData, orderBookData, history, signalColor, monitorOutcome) {
  if (!priceData || !orderBookData) {
    return null;
  }
  
  const signals = [];
  
  // 1. Анализ абсолютного значения цены
  // Для RED сигнала: если цена UP > 0.5, рынок ушел в GREEN → сигнал отменяется
  // Для GREEN сигнала: если цена DOWN > 0.5, рынок ушел в RED → сигнал отменяется
  if (signalColor === 'red' && priceData.price > 0.5) {
    signals.push({
      type: 'price_above_threshold',
      severity: 'high',
      message: `Цена UP ($${priceData.price.toFixed(4)}) выше $0.50 - рынок ушел в GREEN, сигнал RED отменяется`,
    });
  } else if (signalColor === 'green' && priceData.price > 0.5) {
    signals.push({
      type: 'price_above_threshold',
      severity: 'high',
      message: `Цена DOWN ($${priceData.price.toFixed(4)}) выше $0.50 - рынок ушел в RED, сигнал GREEN отменяется`,
    });
  }
  
  // 2. Анализ изменения цены
  // Для ОБОИХ сигналов: рост цены мониторинга = отмена сигнала
  // GREEN сигнал (ставим на RED/down): если цена DOWN растет → сигнал отменяется
  // RED сигнал (ставим на GREEN/up): если цена UP растет → сигнал отменяется
  if (history.length > 1) {
    const priceChange = priceData.price - history[history.length - 2].price;
    const priceChangePercent = (priceChange / history[history.length - 2].price) * 100;
    const prevPrice = history[history.length - 2].price;
    const isVeryLowPrice = prevPrice < 0.1;
    
    // Для очень низких цен (< $0.1) процентные изменения могут быть обманчивыми
    // Важнее абсолютное изменение и текущее значение цены
    if (isVeryLowPrice) {
      // При очень низкой цене рост на > $0.05 или цена стала > $0.1 - это отмена
      if (priceChange > 0.05 || priceData.price > 0.1) {
        signals.push({
          type: 'price_increase',
          severity: 'high',
          message: `Цена ${monitorOutcome.toUpperCase()} выросла с $${prevPrice.toFixed(4)} до $${priceData.price.toFixed(4)} (${priceChangePercent.toFixed(2)}%) - возможна отмена`,
        });
      } else if (priceChange < -0.05) {
        signals.push({
          type: 'price_decrease',
          severity: 'low',
          message: `Цена ${monitorOutcome.toUpperCase()} упала с $${prevPrice.toFixed(4)} до $${priceData.price.toFixed(4)} (${priceChangePercent.toFixed(2)}%) - сигнал подтверждается`,
        });
      }
    } else {
      // Для нормальных цен используем процентные изменения
      if (priceChangePercent > 2) {
        signals.push({
          type: 'price_increase',
          severity: 'high',
          message: `Цена ${monitorOutcome.toUpperCase()} выросла на ${priceChangePercent.toFixed(2)}% - возможна отмена`,
        });
      } else if (priceChangePercent < -2) {
        signals.push({
          type: 'price_decrease',
          severity: 'low',
          message: `Цена ${monitorOutcome.toUpperCase()} упала на ${Math.abs(priceChangePercent).toFixed(2)}% - сигнал подтверждается`,
        });
      }
    }
  }
  
  // 2. Анализ order book
  // imbalance = (asksTotal - bidsTotal) / totalSize (из analyzeOrderBook)
  // Положительный imbalance = больше продавцов (asks > bids) → цена падает → сигнал подтверждается ✅
  // Отрицательный imbalance = больше покупателей (bids > asks) → цена растет → сигнал отменяется ❌
  // Для ОБОИХ сигналов: больше продавцов (asks > bids, imbalance > 0) → цена падает → сигнал подтверждается
  // Для ОБОИХ сигналов: больше покупателей (bids > asks, imbalance < 0) → цена растет → сигнал отменяется
  if (orderBookData.imbalance > 0.1) {
    // Положительный imbalance = больше продавцов = хорошо (подтверждает сигнал)
    signals.push({
      type: 'orderbook_imbalance_sellers',
      severity: 'low',
      message: `Больше продавцов (imbalance: ${(orderBookData.imbalance * 100).toFixed(1)}%) - сигнал подтверждается`,
    });
  } else if (orderBookData.imbalance < -0.1) {
    // Отрицательный imbalance = больше покупателей = плохо (отменяет сигнал)
    signals.push({
      type: 'orderbook_imbalance_buyers',
      severity: 'medium',
      message: `Больше покупателей (imbalance: ${(orderBookData.imbalance * 100).toFixed(1)}%) - возможна отмена`,
    });
  }
  
  // 3. Анализ спреда
  // Большой спред → низкая ликвидность → нестабильность
  if (orderBookData.spread > 0.05) {
    signals.push({
      type: 'wide_spread',
      severity: 'medium',
      message: `Широкий спред ${(orderBookData.spread * 100).toFixed(2)}% - низкая ликвидность`,
    });
  }
  
  // Общая оценка вероятности отмены
  const highSeverityCount = signals.filter(s => s.severity === 'high').length;
  const mediumSeverityCount = signals.filter(s => s.severity === 'medium').length;
  
  let cancelProbability = 0;
  if (highSeverityCount > 0) {
    cancelProbability = 0.7 + (highSeverityCount * 0.1);
  } else if (mediumSeverityCount > 1) {
    cancelProbability = 0.4 + (mediumSeverityCount * 0.1);
  } else if (mediumSeverityCount === 1) {
    cancelProbability = 0.2;
  }
  
  return {
    probability: Math.min(cancelProbability, 0.9),
    signals,
    recommendation: cancelProbability > 0.5 ? 'НЕ ПОКУПАТЬ - высокая вероятность отмены' : 
                    cancelProbability > 0.3 ? 'ОСТОРОЖНО - возможна отмена' : 
                    'МОЖНО ПОКУПАТЬ - сигнал стабилен',
  };
}

// Основная функция
async function monitorSignalCancel() {
  const marketSlug = getCurrentMarketSlug('eth');
  const startTime = Date.now();
  const endTime = startTime + MONITOR_DURATION_MS;
  
  const nextMarketSlug = getNextMarketSlug(marketSlug, 'eth');
  
  console.log('='.repeat(70));
  console.log('МОНИТОРИНГ ОТМЕНЫ СИГНАЛА');
  console.log('='.repeat(70));
  console.log(`Текущий рынок: ${marketSlug}`);
  console.log(`Следующий рынок: ${nextMarketSlug}`);
  console.log(`Сигнал: 2 ${SIGNAL_COLOR.toUpperCase()} свечи → ставим на ${BET_COLOR.toUpperCase()} (${BET_OUTCOME})`);
  console.log(`Мониторим на текущем рынке: ${MONITOR_OUTCOME.toUpperCase()}`);
  console.log(`Длительность мониторинга: ${MONITOR_DURATION_MS / 1000 / 60} минут`);
  console.log(`Интервал: ${INTERVAL_MS / 1000} секунд`);
  console.log(`Проверка стабильности через: ${STABILITY_CHECK_TIME_MS / 1000} секунд`);
  console.log(`Начало: ${new Date(startTime).toLocaleString()}`);
  console.log(`Конец: ${new Date(endTime).toLocaleString()}`);
  console.log('='.repeat(70));
  console.log();
  
  const history = [];
  const nextMarketPrices = []; // Цены на следующий рынок
  let iteration = 0;
  let stabilityChecked = false;
  let lastStabilityCheckTime = 0;
  let lastStabilityResult = null;
  const STABILITY_RECHECK_INTERVAL_MS = 30 * 1000; // Повторная проверка каждые 30 секунд
  
  // Первое измерение
  try {
    const priceData = await polymarket.getBuyPrice(marketSlug, MONITOR_OUTCOME);
    if (priceData && priceData.price && priceData.tokenId) {
      const orderBookData = await polymarket.getOrderBookDetails(priceData.tokenId);
      const orderBookAnalysis = orderBookData ? analyzeOrderBook(orderBookData.bids, orderBookData.asks) : null;
      
      const elapsed = Date.now() - startTime;
      const record = {
        iteration: iteration++,
        elapsed: elapsed,
        elapsedFormatted: formatTime(elapsed),
        timestamp: new Date().toISOString(),
        price: priceData.price,
        tokenId: priceData.tokenId,
        orderBook: orderBookAnalysis,
      };
      history.push(record);
      
      console.log(`[${record.elapsedFormatted}] Цена ${MONITOR_OUTCOME.toUpperCase()} (текущий рынок): $${priceData.price.toFixed(4)}`);
      if (orderBookAnalysis) {
        console.log(`  Order Book: Bids ${orderBookAnalysis.bidsTotal.toFixed(0)} | Asks ${orderBookAnalysis.asksTotal.toFixed(0)} | Spread ${(orderBookAnalysis.spread * 100).toFixed(2)}%`);
      }
      
      // Получаем цену на следующий рынок
      try {
        const nextPriceData = await polymarket.getBuyPrice(nextMarketSlug, BET_OUTCOME);
        if (nextPriceData && nextPriceData.price) {
          nextMarketPrices.push({
            elapsed: elapsed,
            price: nextPriceData.price,
            timestamp: new Date().toISOString(),
          });
          console.log(`  💰 Цена ${BET_OUTCOME.toUpperCase()} (следующий рынок): $${nextPriceData.price.toFixed(4)}`);
        }
      } catch (error) {
        // Следующий рынок может еще не существовать
      }
    } else {
      console.log(`[${formatTime(Date.now() - startTime)}] Не удалось получить данные (рынок еще не создан?)`);
    }
  } catch (error) {
    console.error(`Ошибка при получении данных:`, error.message);
  }
  
  // Периодический мониторинг
  const intervalId = setInterval(async () => {
    const now = Date.now();
    
    if (now >= endTime) {
      clearInterval(intervalId);
      await finishMonitoring(history, startTime, marketSlug, nextMarketPrices);
      return;
    }
    
    try {
      const elapsed = now - startTime;
      
      // Первая проверка стабильности через 2 минуты (чтобы набралось 12 записей для анализа)
      if (!stabilityChecked && elapsed >= STABILITY_CHECK_TIME_MS) {
        stabilityChecked = true;
        lastStabilityCheckTime = now;
        const stability = checkStability(history, SIGNAL_COLOR);
        lastStabilityResult = stability;
        
        console.log(`\n${'='.repeat(70)}`);
        console.log(`ПРОВЕРКА СТАБИЛЬНОСТИ (через ${STABILITY_CHECK_TIME_MS / 1000} сек)`);
        console.log(`${'='.repeat(70)}`);
        console.log(`Стабильность: ${stability.stable ? '✅ СТАБИЛЬНО' : '❌ НЕ СТАБИЛЬНО'}`);
        console.log(`Причина: ${stability.reason}`);
        
        if (stability.stable) {
          console.log(`\n🎯 ПОКУПКА!`);
          console.log(`Рынок стабилен, сигнал подтверждается, можно покупать ${BET_OUTCOME.toUpperCase()} на следующем рынке`);
        } else {
          console.log(`\n⚠️  НЕ ПОКУПАТЬ`);
          console.log(`Рынок нестабилен, сигнал может отмениться`);
        }
        console.log(`${'='.repeat(70)}\n`);
      }
      
      // Повторная проверка стабильности каждые 30 секунд после первой проверки
      if (stabilityChecked && (now - lastStabilityCheckTime) >= STABILITY_RECHECK_INTERVAL_MS) {
        lastStabilityCheckTime = now;
        const stability = checkStability(history, SIGNAL_COLOR);
        
        // Всегда выводим результат повторной проверки
        const statusChanged = !lastStabilityResult || lastStabilityResult.stable !== stability.stable;
        const statusEmoji = statusChanged ? '🔄' : '⏱️';
        const statusText = statusChanged ? 'ПОВТОРНАЯ ПРОВЕРКА СТАБИЛЬНОСТИ (СТАТУС ИЗМЕНИЛСЯ)' : 'ПОВТОРНАЯ ПРОВЕРКА СТАБИЛЬНОСТИ';
        
        console.log(`\n${'='.repeat(70)}`);
        console.log(`${statusEmoji} ${statusText}`);
        console.log(`${'='.repeat(70)}`);
        console.log(`Стабильность: ${stability.stable ? '✅ СТАБИЛЬНО' : '❌ НЕ СТАБИЛЬНО'}`);
        console.log(`Причина: ${stability.reason}`);
        
        if (stability.stable) {
          if (statusChanged && lastStabilityResult && !lastStabilityResult.stable) {
            console.log(`\n🎯 ПОКУПКА!`);
            console.log(`Рынок стал стабильным, сигнал подтверждается, можно покупать ${BET_OUTCOME.toUpperCase()} на следующем рынке`);
          } else if (statusChanged) {
            console.log(`\n🎯 ПОКУПКА!`);
            console.log(`Рынок стабилен, сигнал подтверждается, можно покупать ${BET_OUTCOME.toUpperCase()} на следующем рынке`);
          } else {
            console.log(`\n✅ Статус не изменился - рынок остается стабильным`);
          }
        } else {
          if (statusChanged && lastStabilityResult && lastStabilityResult.stable) {
            console.log(`\n⚠️  ОТМЕНА ПОКУПКИ`);
            console.log(`Рынок стал нестабильным, сигнал может отмениться`);
          } else if (statusChanged) {
            console.log(`\n⚠️  НЕ ПОКУПАТЬ`);
            console.log(`Рынок нестабилен, сигнал может отмениться`);
          } else {
            console.log(`\n❌ Статус не изменился - рынок остается нестабильным`);
          }
        }
        console.log(`${'='.repeat(70)}\n`);
        
        lastStabilityResult = stability;
      }
      
      const priceData = await polymarket.getBuyPrice(marketSlug, MONITOR_OUTCOME);
      if (priceData && priceData.price && priceData.tokenId) {
        const orderBookData = await polymarket.getOrderBookDetails(priceData.tokenId);
        const orderBookAnalysis = orderBookData ? analyzeOrderBook(orderBookData.bids, orderBookData.asks) : null;
        
        const record = {
          iteration: iteration++,
          elapsed: elapsed,
          elapsedFormatted: formatTime(elapsed),
          timestamp: new Date().toISOString(),
          price: priceData.price,
          tokenId: priceData.tokenId,
          orderBook: orderBookAnalysis,
        };
        history.push(record);
        
        // Показываем изменение цены
        let priceChangeText = '';
        if (history.length > 1) {
          const prevPrice = history[history.length - 2].price;
          const change = priceData.price - prevPrice;
          const changePercent = (change / prevPrice) * 100;
          const changeSymbol = change > 0 ? '+' : '';
          priceChangeText = ` (${changeSymbol}${change.toFixed(4)} / ${changeSymbol}${changePercent.toFixed(2)}%)`;
        }
        
        console.log(`[${record.elapsedFormatted}] Цена ${MONITOR_OUTCOME.toUpperCase()} (текущий рынок): $${priceData.price.toFixed(4)}${priceChangeText}`);
        
        if (orderBookAnalysis) {
          console.log(`  Order Book: Bids ${orderBookAnalysis.bidsTotal.toFixed(0)} | Asks ${orderBookAnalysis.asksTotal.toFixed(0)} | Spread ${(orderBookAnalysis.spread * 100).toFixed(2)}% | Imbalance: ${(orderBookAnalysis.imbalance * 100).toFixed(1)}%`);
        }
        
        // Получаем цену на следующий рынок
        try {
          const nextPriceData = await polymarket.getBuyPrice(nextMarketSlug, BET_OUTCOME);
          if (nextPriceData && nextPriceData.price) {
            nextMarketPrices.push({
              elapsed: elapsed,
              price: nextPriceData.price,
              timestamp: new Date().toISOString(),
            });
            
            // Показываем изменение цены на следующем рынке
            let nextPriceChangeText = '';
            if (nextMarketPrices.length > 1) {
              const prevNextPrice = nextMarketPrices[nextMarketPrices.length - 2].price;
              const nextChange = nextPriceData.price - prevNextPrice;
              const nextChangePercent = (nextChange / prevNextPrice) * 100;
              const nextChangeSymbol = nextChange > 0 ? '+' : '';
              nextPriceChangeText = ` (${nextChangeSymbol}${nextChange.toFixed(4)} / ${nextChangeSymbol}${nextChangePercent.toFixed(2)}%)`;
            }
            
            console.log(`  💰 Цена ${BET_OUTCOME.toUpperCase()} (следующий рынок): $${nextPriceData.price.toFixed(4)}${nextPriceChangeText}`);
          }
        } catch (error) {
          // Следующий рынок может еще не существовать
        }
        
        // Информационный вывод checkStability каждые 10 секунд (только для мониторинга)
        if (history.length >= 3) {
          const stability = checkStability(history, SIGNAL_COLOR);
          console.log(`  📊 Стабильность: ${stability.stable ? '✅ СТАБИЛЬНО' : '❌ НЕ СТАБИЛЬНО'} - ${stability.reason}`);
        }
        
        // Анализ вероятности отмены (закомментировано)
        // const cancelAnalysis = estimateCancelProbability(priceData, orderBookAnalysis, history, SIGNAL_COLOR, MONITOR_OUTCOME);
        // if (cancelAnalysis) {
        //   console.log(`  ⚠️  Вероятность отмены: ${(cancelAnalysis.probability * 100).toFixed(0)}% - ${cancelAnalysis.recommendation}`);
        //   if (cancelAnalysis.signals.length > 0) {
        //     cancelAnalysis.signals.forEach(signal => {
        //       console.log(`     - ${signal.message}`);
        //     });
        //   }
        // }
        console.log();
      } else {
        console.log(`[${formatTime(now - startTime)}] Не удалось получить данные`);
      }
    } catch (error) {
      console.error(`[${formatTime(now - startTime)}] Ошибка:`, error.message);
    }
  }, INTERVAL_MS);
  
  // Обработка завершения по Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\n\nПрерывание мониторинга...');
    clearInterval(intervalId);
    await finishMonitoring(history, startTime, marketSlug, nextMarketPrices);
    process.exit(0);
  });
}

// Завершение мониторинга и анализ
async function finishMonitoring(history, startTime, marketSlug, nextMarketPrices = []) {
  console.log('\n' + '='.repeat(70));
  console.log('МОНИТОРИНГ ЗАВЕРШЕН');
  console.log('='.repeat(70));
  
  if (history.length === 0) {
    console.log('Нет данных для анализа');
    return;
  }
  
  // Статистика по цене
  const prices = history.map(h => h.price).filter(p => p > 0);
  if (prices.length === 0) {
    console.log('Нет данных о ценах');
    return;
  }
  
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  const totalChange = lastPrice - firstPrice;
  const totalChangePercent = (totalChange / firstPrice) * 100;
  
  console.log(`\nСТАТИСТИКА ПО ЦЕНЕ:`);
  console.log(`  Всего измерений: ${history.length}`);
  console.log(`  Первая цена: $${firstPrice.toFixed(4)}`);
  console.log(`  Последняя цена: $${lastPrice.toFixed(4)}`);
  console.log(`  Минимальная цена: $${minPrice.toFixed(4)}`);
  console.log(`  Максимальная цена: $${maxPrice.toFixed(4)}`);
  console.log(`  Средняя цена: $${avgPrice.toFixed(4)}`);
  console.log(`  Изменение: ${totalChange >= 0 ? '+' : ''}${totalChange.toFixed(4)} (${totalChangePercent >= 0 ? '+' : ''}${totalChangePercent.toFixed(2)}%)`);
  
  // Статистика по order book
  const orderBooks = history.map(h => h.orderBook).filter(ob => ob !== null);
  if (orderBooks.length > 0) {
    const avgBidsTotal = orderBooks.reduce((sum, ob) => sum + ob.bidsTotal, 0) / orderBooks.length;
    const avgAsksTotal = orderBooks.reduce((sum, ob) => sum + ob.asksTotal, 0) / orderBooks.length;
    const avgSpread = orderBooks.reduce((sum, ob) => sum + ob.spread, 0) / orderBooks.length;
    const avgImbalance = orderBooks.reduce((sum, ob) => sum + ob.imbalance, 0) / orderBooks.length;
    
    console.log(`\nСТАТИСТИКА ПО ORDER BOOK:`);
    console.log(`  Средний размер bids: ${avgBidsTotal.toFixed(0)}`);
    console.log(`  Средний размер asks: ${avgAsksTotal.toFixed(0)}`);
    console.log(`  Средний спред: ${(avgSpread * 100).toFixed(2)}%`);
    console.log(`  Средний imbalance: ${(avgImbalance * 100).toFixed(1)}%`);
  }
  
  // Финальный анализ отмены (с учетом общего изменения)
  const firstRecord = history[0];
  const lastRecord = history[history.length - 1];
  
  if (firstRecord && lastRecord && lastRecord.orderBook) {
    // Общее изменение цены за весь период
    const totalChange = lastRecord.price - firstRecord.price;
    const totalChangePercent = firstRecord.price > 0 ? (totalChange / firstRecord.price) * 100 : 0;
    
    // Анализ на основе общего изменения
    let finalRecommendation = '';
    let finalProbability = 0;
    const finalSignals = [];
    
    // Для green сигнала: если цена DOWN падает → сигнал подтверждается
    // Для red сигнала: если цена UP падает → сигнал подтверждается
    if (totalChangePercent < -10) {
      // Цена упала значительно (> 10%) → сигнал подтверждается
      finalProbability = 0.1; // Низкая вероятность отмены
      finalRecommendation = 'МОЖНО ПОКУПАТЬ - сигнал подтверждается';
      finalSignals.push({
        severity: 'low',
        message: `Цена ${MONITOR_OUTCOME.toUpperCase()} упала на ${Math.abs(totalChangePercent).toFixed(2)}% - сигнал подтверждается`,
      });
    } else if (totalChangePercent < -5) {
      // Цена упала умеренно (5-10%) → сигнал подтверждается
      finalProbability = 0.2;
      finalRecommendation = 'МОЖНО ПОКУПАТЬ - сигнал стабилен';
      finalSignals.push({
        severity: 'low',
        message: `Цена ${MONITOR_OUTCOME.toUpperCase()} упала на ${Math.abs(totalChangePercent).toFixed(2)}% - сигнал подтверждается`,
      });
    } else if (totalChangePercent > 10) {
      // Цена выросла значительно (> 10%) → сигнал отменяется
      finalProbability = 0.9;
      finalRecommendation = 'НЕ ПОКУПАТЬ - сигнал отменяется';
      finalSignals.push({
        severity: 'high',
        message: `Цена ${MONITOR_OUTCOME.toUpperCase()} выросла на ${totalChangePercent.toFixed(2)}% - сигнал отменяется`,
      });
    } else if (totalChangePercent > 2) {
      // Цена выросла умеренно (2-10%) → возможна отмена
      finalProbability = 0.6;
      finalRecommendation = 'ОСТОРОЖНО - возможна отмена';
      finalSignals.push({
        severity: 'medium',
        message: `Цена ${MONITOR_OUTCOME.toUpperCase()} выросла на ${totalChangePercent.toFixed(2)}% - возможна отмена`,
      });
    } else {
      // Цена стабильна (-5% до +2%) → нужно смотреть на order book
      finalProbability = 0.3;
      finalRecommendation = 'НЕОПРЕДЕЛЕННО - нужен дополнительный анализ';
      finalSignals.push({
        severity: 'medium',
        message: `Цена ${MONITOR_OUTCOME.toUpperCase()} изменилась на ${totalChangePercent >= 0 ? '+' : ''}${totalChangePercent.toFixed(2)}% - стабильна`,
      });
    }
    
    // Учитываем order book
    if (lastRecord.orderBook) {
      const imbalance = lastRecord.orderBook.imbalance;
      if (imbalance < -0.10) {
        // Больше продавцов (> 10%) → подтверждает сигнал
        finalProbability = Math.max(0, finalProbability - 0.2);
        finalSignals.push({
          severity: 'low',
          message: `Больше продавцов (imbalance: ${(imbalance * 100).toFixed(1)}%) - сигнал подтверждается`,
        });
      } else if (imbalance > 0.10) {
        // Больше покупателей (> 10%) → возможна отмена
        finalProbability = Math.min(0.9, finalProbability + 0.2);
        finalSignals.push({
          severity: 'medium',
          message: `Больше покупателей (imbalance: ${(imbalance * 100).toFixed(1)}%) - возможна отмена`,
        });
      }
    }
    
    // Обновляем рекомендацию на основе финальной вероятности
    if (finalProbability < 0.3) {
      finalRecommendation = 'МОЖНО ПОКУПАТЬ - сигнал подтверждается';
    } else if (finalProbability > 0.6) {
      finalRecommendation = 'НЕ ПОКУПАТЬ - высокая вероятность отмены';
    } else {
      finalRecommendation = 'ОСТОРОЖНО - возможна отмена';
    }
    
    console.log(`\nФИНАЛЬНЫЙ АНАЛИЗ ОТМЕНЫ СИГНАЛА:`);
    console.log(`  Общее изменение цены: ${totalChangePercent >= 0 ? '+' : ''}${totalChangePercent.toFixed(2)}% (от $${firstRecord.price.toFixed(4)} до $${lastRecord.price.toFixed(4)})`);
    console.log(`  Вероятность отмены: ${(finalProbability * 100).toFixed(0)}%`);
    console.log(`  Рекомендация: ${finalRecommendation}`);
    if (finalSignals.length > 0) {
      console.log(`  Сигналы:`);
      finalSignals.forEach(signal => {
        console.log(`    - [${signal.severity.toUpperCase()}] ${signal.message}`);
      });
    }
  }
  
  // Сохраняем данные в файл
  const fs = require('fs');
  const filename = `signal-cancel-monitor-${Date.now()}.json`;
    const output = {
    currentMarketSlug: marketSlug,
    nextMarketSlug: getNextMarketSlug(marketSlug, 'eth'),
    signalColor: SIGNAL_COLOR,
    betColor: BET_COLOR,
    betOutcome: BET_OUTCOME,
    monitorOutcome: MONITOR_OUTCOME,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date().toISOString(),
    duration: Date.now() - startTime,
    statistics: {
      price: {
        firstPrice,
        lastPrice,
        minPrice,
        maxPrice,
        avgPrice,
        totalChange,
        totalChangePercent,
      },
    },
    history,
  };
  
  // Статистика по ценам на следующий рынок
  if (nextMarketPrices.length > 0) {
    const nextPrices = nextMarketPrices.map(p => p.price).filter(p => p > 0);
    if (nextPrices.length > 0) {
      const nextMinPrice = Math.min(...nextPrices);
      const nextMaxPrice = Math.max(...nextPrices);
      const nextAvgPrice = nextPrices.reduce((a, b) => a + b, 0) / nextPrices.length;
      const nextFirstPrice = nextPrices[0];
      const nextLastPrice = nextPrices[nextPrices.length - 1];
      
      console.log(`\nСТАТИСТИКА ПО ЦЕНЕ НА СЛЕДУЮЩЕМ РЫНКЕ:`);
      console.log(`  Всего измерений: ${nextMarketPrices.length}`);
      console.log(`  Первая цена: $${nextFirstPrice.toFixed(4)}`);
      console.log(`  Последняя цена: $${nextLastPrice.toFixed(4)}`);
      console.log(`  Минимальная цена: $${nextMinPrice.toFixed(4)}`);
      console.log(`  Максимальная цена: $${nextMaxPrice.toFixed(4)}`);
      console.log(`  Средняя цена: $${nextAvgPrice.toFixed(4)}`);
      
      output.statistics.nextMarket = {
        firstPrice: nextFirstPrice,
        lastPrice: nextLastPrice,
        minPrice: nextMinPrice,
        maxPrice: nextMaxPrice,
        avgPrice: nextAvgPrice,
      };
    }
  }
  
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`\nДанные сохранены в: ${filename}`);
}

// Запуск
monitorSignalCancel().catch(error => {
  console.error('Критическая ошибка:', error);
  process.exit(1);
});

