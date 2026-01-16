# План изменений в коде

## 1. УДАЛЕНИЕ sellStrategy

### 1.1. TRADING_CONFIGS (строки 10-51)

**УДАЛИТЬ:**
- Строка 21: `sellStrategy: 'signal',`
- Строка 33: `sellStrategy: 'signal',`
- Строка 49: `sellStrategy: 'hold',` (уже закомментировано)

**РЕЗУЛЬТАТ:**
```javascript
bot1: {
  // ... остальные поля ...
  buyStrategy: 'signal',
  // sellStrategy удален
},
bot2: {
  // ... остальные поля ...
  buyStrategy: 'signal',
  // sellStrategy удален
},
```

### 1.2. Конструктор (строка 100)

**УДАЛИТЬ:**
```javascript
this.config.sellStrategy = this.config.sellStrategy || 'signal';
```

**УДАЛИТЬ из лога (строка 102):**
```javascript
console.log(`[TRADE] [${botId}] Initialized with ... sellStrategy: ${this.config.sellStrategy}`);
```

**ИЗМЕНИТЬ на:**
```javascript
console.log(`[TRADE] [${botId}] Initialized with ... buyStrategy: ${this.config.buyStrategy}`);
```

### 1.3. checkSeries - проверка отмены сигнала (строка 1058)

**БЫЛО:**
```javascript
if (series.signalMarketSlug && series.currentStep === 1 && this.config.sellStrategy === 'signal') {
  // ...
}
```

**СТАНЕТ:**
```javascript
if (series.signalMarketSlug && series.currentStep === 1) {
  // Убрали проверку sellStrategy
  // ...
}
```

### 1.4. checkSeries - продажа хеджа (строка 1106)

**БЫЛО:**
```javascript
if (series.nextStepBought && currentColor === series.betColor && timeToEnd <= 20 && this.config.sellStrategy === 'signal') {
  await this.sellHedge(series, timeToEnd);
}
```

**СТАНЕТ:**
```javascript
if (series.nextStepBought && currentColor === series.betColor && timeToEnd <= 20) {
  await this.sellHedge(series, timeToEnd);
}
```

---

## 2. ИЗМЕНЕНИЕ buyStrategy: 'validated' → 'validate'

### 2.1. TRADING_CONFIGS

**ИЗМЕНИТЬ комментарии:**
```javascript
buyStrategy: 'signal',      // Тип покупки: "signal" - покупаем сразу по сигналу, "validate" - валидируем рынок перед покупкой
```

### 2.2. onSignal (строка 413)

**БЫЛО:**
```javascript
if (this.config.buyStrategy === 'validated') {
  // TODO: Реализовать логику проверки стабильности перед покупкой
  // Пока используем стратегию 'signal' как fallback
  console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: buyStrategy 'validated' not yet implemented, using 'signal' as fallback`);
  bought = await this.buyStep(series);
} else {
  // buyStrategy === 'signal' (по умолчанию) - покупаем сразу по сигналу
  bought = await this.buyStep(series);
}
```

**СТАНЕТ:**
```javascript
if (this.config.buyStrategy === 'validate') {
  // Начинаем валидацию рынка (валидируем рынок где сигнал)
  series.validationState = 'validating';
  series.validationMarketSlug = signalMarketSlug; // Валидируем рынок где сигнал
  series.validationHistory = [];
  series.lastValidationCheck = null;
  
  // Добавляем событие валидации
  const validationEvent = series.addEvent('validation_started', {
    message: 'Валидирую рынок:',
  });
  series.validationEventId = validationEvent._id || validationEvent.id;
  
  // НЕ вызываем buyStep() - ждем валидации
  await series.save();
  this.activeSeries.set(type, series);
  
  console.log(`[TRADE] [${this.botId}] ${type.toUpperCase()}: Started validation for signal market ${signalMarketSlug}`);
  await this.notifyUsers(series, 'Валидация рынка...');
  return; // Выходим, не покупаем сразу
} else {
  // buyStrategy === 'signal' (по умолчанию) - покупаем сразу по сигналу
  bought = await this.buyStep(series);
}
```

**ВАЖНО:** `signalMarketSlug` уже есть в `onSignal` (строка 395), используем его для валидации.

---

## 3. НОВАЯ ФУНКЦИЯ validateMarket

### 3.1. Добавить после функции `buyNextStepEarly` (после строки 791)

```javascript
// ==================== ВАЛИДАЦИЯ РЫНКА ====================

async validateMarket(series) {
  const asset = series.asset.toUpperCase();
  
  // Получаем контекст для рынка валидации (рынок где сигнал)
  const isBinance = config.dataSource === 'binance';
  const context = isBinance 
    ? await this.dataProvider.get15mContext(series.asset)
    : await this.dataProvider.get15mContext(config.polymarket.markets[series.asset]);
  
  // Находим рынок валидации в контексте
  const validationSlug = series.validationMarketSlug; // Рынок где сигнал
  const getTimestamp = (slug) => parseInt(slug.split('-').pop());
  const validationTimestamp = getTimestamp(validationSlug);
  
  // Определяем какой это рынок (current, prev1, etc.)
  const currentTimestamp = getTimestamp(context.slugs.current);
  const prev1Timestamp = getTimestamp(context.slugs.prev1);
  
  let timeToEnd = null;
  
  if (validationTimestamp === currentTimestamp) {
    // Валидируем текущий рынок (где сигнал)
    timeToEnd = context.current.timeToEnd;
  } else if (validationTimestamp === prev1Timestamp) {
    // Рынок уже закрылся - валидация не нужна
    console.log(`[TRADE] [${this.botId}] ${asset}: Validation market ${validationSlug} already closed`);
    // Отменяем валидацию, не покупаем
    await this.completeValidation(series, false);
    return;
  } else {
    // Рынок еще не наступил или потеряли его
    console.log(`[TRADE] [${this.botId}] ${asset}: Validation market ${validationSlug} not found in context`);
    return;
  }
  
  // Проверка: за 1 минуту до конца принимаем решение
  if (timeToEnd !== null && timeToEnd <= 60) {
    // Принимаем решение
    const last10 = series.validationHistory.slice(-10);
    const allMatch = last10.length === 10 && last10.every(h => h.matches === true);
    
    if (allMatch) {
      // 10 подряд '+' - покупаем
      await this.completeValidation(series, true);
    } else {
      // Нет 10 подряд '+' - не покупаем, отменяем серию
      await this.completeValidation(series, false);
    }
    return;
  }
  
  // Проверка интервала (каждые 30 сек)
  const now = new Date();
  if (series.lastValidationCheck === null) {
    // Первая проверка
    await this.performValidationCheck(series, validationSlug);
  } else {
    const timeSinceLastCheck = now - series.lastValidationCheck;
    if (timeSinceLastCheck >= 30000) { // 30 секунд
      await this.performValidationCheck(series, validationSlug);
    }
  }
  
  // Проверка условий покупки (10 подряд '+')
  const last10 = series.validationHistory.slice(-10);
  if (last10.length === 10) {
    const allMatch = last10.every(h => h.matches === true);
    if (allMatch) {
      // 10 подряд '+' - покупаем
      await this.completeValidation(series, true);
    }
  }
}

async performValidationCheck(series, marketSlug) {
  const asset = series.asset.toUpperCase();
  const polymarket = require('./polymarket');
  
  // Определяем какую цену проверяем
  const betOutcome = series.betColor === 'green' ? 'up' : 'down';
  const polySlug = this.convertToPolymarketSlug(marketSlug);
  
  let price = null;
  try {
    const priceData = await polymarket.getBuyPrice(polySlug, betOutcome);
    if (priceData && priceData.price) {
      price = priceData.price;
    }
  } catch (error) {
    console.error(`[TRADE] [${this.botId}] Error getting price for validation:`, error.message);
    return;
  }
  
  if (!price) {
    return;
  }
  
  // Проверяем соответствует ли цена сигналу
  const matches = this.checkPriceMatchesSignal(price, series.signalColor);
  const symbol = matches ? '+' : '-';
  
  // Добавляем в историю
  series.validationHistory.push({
    timestamp: new Date(),
    price,
    matches,
    symbol,
  });
  
  // Ограничиваем историю (храним последние 50 записей)
  if (series.validationHistory.length > 50) {
    series.validationHistory = series.validationHistory.slice(-50);
  }
  
  // Обновляем время последней проверки
  series.lastValidationCheck = new Date();
  
  // Обновляем событие (показываем последние 20 символов)
  const symbols = series.validationHistory.map(h => h.symbol).join('');
  const displaySymbols = symbols.slice(-20); // Последние 20 символов
  
  // Находим событие и обновляем его
  const eventIndex = series.events.findIndex(e => 
    e._id?.toString() === series.validationEventId?.toString() ||
    e.id?.toString() === series.validationEventId?.toString()
  );
  
  if (eventIndex !== -1) {
    series.events[eventIndex].data.message = `Валидирую рынок: ${displaySymbols}`;
  }
  
  await series.save();
  
  console.log(`[TRADE] [${this.botId}] ${asset}: Validation check: price $${price.toFixed(3)} → ${symbol} (${series.validationHistory.length} checks)`);
}

checkPriceMatchesSignal(price, signalColor) {
  // Сигнал RED → проверяем цену UP
  // Если price <= 0.5 → сигнал подтверждается (RED)
  // Если price > 0.5 → сигнал отменился (GREEN)
  
  // Сигнал GREEN → проверяем цену DOWN
  // Если price <= 0.5 → сигнал подтверждается (GREEN)
  // Если price > 0.5 → сигнал отменился (RED)
  
  return price <= 0.5;
}

async completeValidation(series, success) {
  const asset = series.asset.toUpperCase();
  
  if (success) {
    // Валидация успешна - покупаем
    series.validationState = 'validated';
    
    // Обновляем событие
    const eventIndex = series.events.findIndex(e => 
      e._id?.toString() === series.validationEventId?.toString() ||
      e.id?.toString() === series.validationEventId?.toString()
    );
    
    if (eventIndex !== -1) {
      const symbols = series.validationHistory.map(h => h.symbol).join('');
      const displaySymbols = symbols.slice(-20);
      series.events[eventIndex].data.message = `Валидирую рынок: ${displaySymbols} ✅ Покупка`;
    }
    
    await series.save();
    
    // Покупаем
    const bought = await this.buyStep(series);
    if (!bought) {
      // Не удалось купить - отменяем серию
      series.status = 'cancelled';
      series.endedAt = new Date();
      series.addEvent('series_cancelled', {
        message: '⛔ Серия отменена: не удалось купить после валидации',
      });
      await series.save();
      this.activeSeries.delete(series.asset);
      return;
    }
    
    await series.save();
    console.log(`[TRADE] [${this.botId}] ${asset}: Validation successful, bought Step 1`);
    await this.notifyUsers(series, '✅ Валидация пройдена, покупка выполнена');
  } else {
    // Валидация не пройдена - отменяем серию
    series.validationState = 'rejected';
    
    // Обновляем событие
    const eventIndex = series.events.findIndex(e => 
      e._id?.toString() === series.validationEventId?.toString() ||
      e.id?.toString() === series.validationEventId?.toString()
    );
    
    if (eventIndex !== -1) {
      const symbols = series.validationHistory.map(h => h.symbol).join('');
      const displaySymbols = symbols.slice(-20);
      series.events[eventIndex].data.message = `Валидирую рынок: ${displaySymbols} ❌ Отменено`;
    }
    
    series.addEvent('validation_rejected', {
      message: 'Валидация не пройдена, покупка отменена',
    });
    
    series.status = 'cancelled';
    series.endedAt = new Date();
    
    await series.save();
    this.activeSeries.delete(series.asset);
    
    console.log(`[TRADE] [${this.botId}] ${asset}: Validation failed, series cancelled`);
    await this.notifyUsers(series, '❌ Валидация не пройдена, серия отменена');
  }
}
```

---

## 4. ИЗМЕНЕНИЕ checkSeries

### 4.1. Добавить в начало checkSeries (после строки 1040)

```javascript
async checkSeries(series) {
  // Проверка валидации (если серия в процессе валидации)
  if (series.validationState === 'validating') {
    await this.validateMarket(series);
    return; // Выходим, не продолжаем обычную логику
  }
  
  // Продолжаем обычную логику...
  const isBinance = config.dataSource === 'binance';
  // ...
}
```

---

## 5. ИЗМЕНЕНИЕ TradeSeries МОДЕЛЬ

### 5.1. src/models/TradeSeries.js

**ДОБАВИТЬ новые поля:**

```javascript
validationState: {
  type: String,
  enum: ['validating', 'validated', 'rejected'],
  default: null,
},
validationHistory: [{
  timestamp: Date,
  price: Number,
  matches: Boolean,
  symbol: String, // '+' или '-'
}],
validationEventId: {
  type: mongoose.Schema.Types.ObjectId,
  default: null,
},
validationMarketSlug: String,
lastValidationCheck: Date,
```

---

## 6. ЛОГИКА ВАЛИДАЦИИ

### 6.1. Какой рынок валидируем

**ВАЛИДИРУЕМ:** Рынок где получен сигнал (`signalMarketSlug`) - чтобы понять, не отменится ли сигнал

**ПОКУПАЕМ НА:** Следующем рынке (`nextMarketSlug`) - если валидация пройдена

**ЛОГИКА:**
- Сигнал получен на текущем рынке (`signalMarketSlug`)
- Мы хотим купить на следующем рынке (`nextMarketSlug`)
- Но сначала валидируем текущий рынок (где сигнал), чтобы понять, не отменится ли он
- Если валидация пройдена (10 подряд '+') → покупаем на следующем рынке
- Если нет → отменяем серию (не покупаем)

**В onSignal уже есть:**
- `signalMarketSlug` - рынок где сигнал (строка 395)
- `nextMarketSlug` - следующий рынок (строка 399)

**Значит:**
- `validationMarketSlug` = `signalMarketSlug` (валидируем рынок где сигнал)

---

## 7. ИЗМЕНЕНИЕ buyNextStepEarly

### 7.1. Убрать проверку buyStrategy (строка 1099)

**БЫЛО:**
```javascript
if (!series.nextStepBought && series.currentStep < this.config.maxSteps && currentColor === series.signalColor && this.config.buyStrategy === 'signal') {
  await this.buyNextStepEarly(series, context);
}
```

**СТАНЕТ:**
```javascript
// Для buyStrategy === 'validate' хедж не покупаем (валидация только для первого шага)
if (!series.nextStepBought && series.currentStep < this.config.maxSteps && currentColor === series.signalColor) {
  if (this.config.buyStrategy === 'signal') {
    await this.buyNextStepEarly(series, context);
  }
  // Для 'validate' хедж не покупаем (или можно добавить логику позже)
}
```

---

## 8. ТЕХНИЧЕСКИЕ ДЕТАЛИ

### 8.1. Обновление события в MongoDB

**Способ:** Обновляем напрямую в объекте `series.events[index].data.message`, затем вызываем `series.save()`

**Код:**
```javascript
const eventIndex = series.events.findIndex(e => 
  e._id?.toString() === series.validationEventId?.toString()
);

if (eventIndex !== -1) {
  series.events[eventIndex].data.message = `Валидирую рынок: ${displaySymbols}`;
  await series.save(); // Mongoose автоматически сохранит изменения
}
```

### 8.2. Ограничение истории

- Хранить последние 50 записей в `validationHistory`
- В сообщении показывать последние 20 символов (чтобы не было слишком длинно)

---

## 9. ПОРЯДОК РЕАЛИЗАЦИИ

1. ✅ Удалить `sellStrategy` из всех мест
2. ✅ Изменить `buyStrategy: 'validated'` → `'validate'`
3. ✅ Добавить поля в TradeSeries модель
4. ✅ Добавить функцию `checkPriceMatchesSignal`
5. ✅ Добавить функцию `validateMarket`
6. ✅ Добавить функцию `performValidationCheck`
7. ✅ Добавить функцию `completeValidation`
8. ✅ Изменить `onSignal` для начала валидации
9. ✅ Изменить `checkSeries` для проверки валидации
10. ✅ Протестировать

