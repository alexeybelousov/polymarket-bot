# План валидации для хеджа

## Текущая логика

**При `buyStrategy === 'signal'`:**
- Когда рынок идет против нас (`currentColor === series.signalColor`)
- Сразу покупаем хедж на следующий рынок (`buyNextStepEarly`)

**При `buyStrategy === 'validate'`:**
- Хедж не покупаем (строка 1334)

## Новая логика

**При `buyStrategy === 'validate'`:**
- Когда рынок идет против нас (`currentColor === series.signalColor`)
- Вместо покупки хеджа сразу, начинаем валидацию следующего рынка
- Валидируем следующий рынок (`context.slugs.next`) - где будем покупать хедж
- Если валидация пройдена (10 подряд '+') → покупаем хедж
- Если нет → просто не покупаем хедж (не отменяем серию, продолжаем без хеджа)

## Отличия от валидации первого шага

1. **Рынок валидации:**
   - Первый шаг: валидируем рынок где сигнал (`signalMarketSlug`)
   - Хедж: валидируем следующий рынок (`context.slugs.next`)

2. **Сигнал для проверки:**
   - Первый шаг: проверяем `series.signalColor`
   - Хедж: проверяем `series.signalColor` (тот же сигнал)

3. **Действие при успехе:**
   - Первый шаг: покупаем Step 1 (`buyStep`)
   - Хедж: покупаем хедж (`buyNextStepEarly`)

4. **Действие при неудаче:**
   - Первый шаг: отменяем серию (`status = 'cancelled'`)
   - Хедж: просто не покупаем хедж (серия продолжается без хеджа)

## Новые поля в TradeSeries

```javascript
// Валидация хеджа
hedgeValidationState: {
  type: String,
  enum: ['validating', 'validated', 'rejected'],
  default: null,
},
hedgeValidationHistory: [{
  timestamp: Date,
  price: Number,
  matches: Boolean,
  symbol: String, // '+' или '-'
}],
hedgeValidationEventIndex: Number,  // Индекс события для обновления
hedgeValidationMarketSlug: String,  // Рынок который валидируем (следующий рынок)
hedgeLastValidationCheck: Date,     // Время последней проверки
```

## Изменения в коде

### 1. TradeSeries модель
- Добавить новые поля для валидации хеджа

### 2. checkSeries (строка 1332-1336)
**БЫЛО:**
```javascript
if (!series.nextStepBought && series.currentStep < this.config.maxSteps && currentColor === series.signalColor && this.config.buyStrategy === 'signal') {
  await this.buyNextStepEarly(series, context);
}
```

**СТАНЕТ:**
```javascript
if (!series.nextStepBought && series.currentStep < this.config.maxSteps && currentColor === series.signalColor) {
  if (this.config.buyStrategy === 'signal') {
    // Покупаем хедж сразу
    await this.buyNextStepEarly(series, context);
  } else if (this.config.buyStrategy === 'validate') {
    // Начинаем валидацию хеджа
    if (!series.hedgeValidationState || series.hedgeValidationState === null) {
      await this.startHedgeValidation(series, context);
    }
  }
}
```

### 3. checkSeries - проверка валидации хеджа
**ДОБАВИТЬ после проверки валидации первого шага:**
```javascript
// Проверка валидации хеджа (если серия в процессе валидации хеджа)
if (series.hedgeValidationState === 'validating') {
  await this.validateHedgeMarket(series);
  // НЕ выходим, продолжаем обычную логику (валидация хеджа не блокирует серию)
}
```

### 4. Новая функция startHedgeValidation
```javascript
async startHedgeValidation(series, context) {
  const asset = series.asset.toUpperCase();
  const nextMarketSlug = context.slugs.next;
  const nextStep = series.currentStep + 1;
  
  // Проверяем, что следующий шаг не превышает maxSteps
  if (nextStep > this.config.maxSteps) {
    return; // Не валидируем если шаг превышает maxSteps
  }
  
  // Начинаем валидацию хеджа
  series.hedgeValidationState = 'validating';
  series.hedgeValidationMarketSlug = nextMarketSlug; // Валидируем следующий рынок
  series.hedgeValidationHistory = [];
  series.hedgeLastValidationCheck = null;
  
  // Добавляем событие валидации хеджа
  series.addEvent('validation_started', {
    message: `Валидирую хедж Step ${nextStep}:`,
  });
  // Сохраняем индекс последнего события
  series.hedgeValidationEventIndex = series.events.length - 1;
  
  await series.save();
  
  console.log(`[TRADE] [${this.botId}] ${asset}: Started hedge validation for Step ${nextStep} on market ${nextMarketSlug}`);
}
```

### 5. Новая функция validateHedgeMarket
```javascript
async validateHedgeMarket(series) {
  const asset = series.asset.toUpperCase();
  
  // Получаем контекст
  const isBinance = config.dataSource === 'binance';
  const context = isBinance 
    ? await this.dataProvider.get15mContext(series.asset)
    : await this.dataProvider.get15mContext(config.polymarket.markets[series.asset]);
  
  // Находим рынок валидации (следующий рынок)
  const validationSlug = series.hedgeValidationMarketSlug;
  const getTimestamp = (slug) => parseInt(slug.split('-').pop());
  const validationTimestamp = getTimestamp(validationSlug);
  
  // Определяем какой это рынок
  const currentTimestamp = getTimestamp(context.slugs.current);
  const nextTimestamp = getTimestamp(context.slugs.next);
  
  let timeToEnd = null;
  
  if (validationTimestamp === currentTimestamp) {
    // Валидируем текущий рынок (следующий рынок уже начался)
    timeToEnd = context.current.timeToEnd;
  } else if (validationTimestamp === nextTimestamp) {
    // Валидируем следующий рынок (еще не начался)
    // Время до начала = timeToEnd текущего рынка + 15 минут
    timeToEnd = context.current.timeToEnd + (15 * 60);
  } else {
    // Рынок уже прошел или еще не наступил
    console.log(`[TRADE] [${this.botId}] ${asset}: Hedge validation market ${validationSlug} not found in context`);
    // Отменяем валидацию хеджа
    series.hedgeValidationState = 'rejected';
    await series.save();
    return;
  }
  
  // Проверка: за 1 минуту до начала/конца принимаем решение
  if (timeToEnd !== null && timeToEnd <= 60) {
    // Принимаем решение
    const last10 = series.hedgeValidationHistory.slice(-10);
    const allMatch = last10.length === 10 && last10.every(h => h.matches === true);
    
    if (allMatch) {
      // 10 подряд '+' - покупаем хедж
      await this.completeHedgeValidation(series, true, context);
    } else {
      // Нет 10 подряд '+' - не покупаем хедж
      await this.completeHedgeValidation(series, false, context);
    }
    return;
  }
  
  // Проверка интервала (каждые 30 сек)
  const now = new Date();
  if (series.hedgeLastValidationCheck === null) {
    // Первая проверка
    await this.performHedgeValidationCheck(series, validationSlug);
  } else {
    const timeSinceLastCheck = now - series.hedgeLastValidationCheck;
    if (timeSinceLastCheck >= 30000) { // 30 секунд
      await this.performHedgeValidationCheck(series, validationSlug);
    }
  }
  
  // Проверка условий покупки (10 подряд '+')
  const last10 = series.hedgeValidationHistory.slice(-10);
  if (last10.length === 10) {
    const allMatch = last10.every(h => h.matches === true);
    if (allMatch) {
      // 10 подряд '+' - покупаем хедж
      await this.completeHedgeValidation(series, true, context);
    }
  }
}
```

### 6. Новая функция performHedgeValidationCheck
```javascript
async performHedgeValidationCheck(series, marketSlug) {
  const asset = series.asset.toUpperCase();
  const polymarket = require('./polymarket');
  
  // Определяем какую цену проверяем (тот же сигнал что и для первого шага)
  const checkOutcome = series.signalColor === 'red' ? 'up' : 'down';
  const polySlug = this.convertToPolymarketSlug(marketSlug);
  
  let price = null;
  try {
    const priceData = await polymarket.getBuyPrice(polySlug, checkOutcome);
    if (priceData && priceData.price) {
      price = priceData.price;
    }
  } catch (error) {
    console.error(`[TRADE] [${this.botId}] Error getting price for hedge validation:`, error.message);
    return;
  }
  
  if (!price) {
    return;
  }
  
  // Проверяем соответствует ли цена сигналу
  const matches = this.checkPriceMatchesSignal(price, series.signalColor);
  const symbol = matches ? '+' : '-';
  
  // Добавляем в историю
  series.hedgeValidationHistory.push({
    timestamp: new Date(),
    price,
    matches,
    symbol,
  });
  
  // Ограничиваем историю (храним последние 50 записей)
  if (series.hedgeValidationHistory.length > 50) {
    series.hedgeValidationHistory = series.hedgeValidationHistory.slice(-50);
  }
  
  // Обновляем время последней проверки
  series.hedgeLastValidationCheck = new Date();
  
  // Обновляем событие (показываем последние 20 символов)
  const symbols = series.hedgeValidationHistory.map(h => h.symbol).join('');
  const displaySymbols = symbols.slice(-20);
  
  // Обновляем событие по индексу
  if (series.hedgeValidationEventIndex !== undefined && series.hedgeValidationEventIndex >= 0 && series.hedgeValidationEventIndex < series.events.length) {
    series.events[series.hedgeValidationEventIndex].message = `Валидирую хедж Step ${series.currentStep + 1}: ${displaySymbols}`;
  }
  
  await series.save();
  
  console.log(`[TRADE] [${this.botId}] ${asset}: Hedge validation check: price $${price.toFixed(3)} → ${symbol} (${series.hedgeValidationHistory.length} checks)`);
}
```

### 7. Новая функция completeHedgeValidation
```javascript
async completeHedgeValidation(series, success, context) {
  const asset = series.asset.toUpperCase();
  const nextStep = series.currentStep + 1;
  
  if (success) {
    // Валидация успешна - покупаем хедж
    series.hedgeValidationState = 'validated';
    
    // Обновляем событие
    if (series.hedgeValidationEventIndex !== undefined && series.hedgeValidationEventIndex >= 0 && series.hedgeValidationEventIndex < series.events.length) {
      const symbols = series.hedgeValidationHistory.map(h => h.symbol).join('');
      const displaySymbols = symbols.slice(-20);
      series.events[series.hedgeValidationEventIndex].message = `Валидирую хедж Step ${nextStep}: ${displaySymbols} ✅ Покупка`;
    }
    
    await series.save();
    
    // Покупаем хедж
    await this.buyNextStepEarly(series, context);
    
    console.log(`[TRADE] [${this.botId}] ${asset}: Hedge validation successful, bought hedge for Step ${nextStep}`);
  } else {
    // Валидация не пройдена - просто не покупаем хедж
    series.hedgeValidationState = 'rejected';
    
    // Обновляем событие
    if (series.hedgeValidationEventIndex !== undefined && series.hedgeValidationEventIndex >= 0 && series.hedgeValidationEventIndex < series.events.length) {
      const symbols = series.hedgeValidationHistory.map(h => h.symbol).join('');
      const displaySymbols = symbols.slice(-20);
      series.events[series.hedgeValidationEventIndex].message = `Валидирую хедж Step ${nextStep}: ${displaySymbols} ❌ Отменено`;
    }
    
    series.addEvent('validation_rejected', {
      message: `Валидация хеджа Step ${nextStep} не пройдена, хедж не покупаем`,
    });
    
    await series.save();
    
    console.log(`[TRADE] [${this.botId}] ${asset}: Hedge validation failed, not buying hedge for Step ${nextStep}`);
  }
}
```

## Важные моменты

1. **Валидация хеджа не блокирует серию:**
   - Если валидация хеджа активна, мы продолжаем обычную логику серии
   - Хедж - это опциональная покупка, не обязательная

2. **Проверка времени:**
   - Если валидируем следующий рынок (еще не начался), `timeToEnd = context.current.timeToEnd + 15 минут`
   - Если валидируем текущий рынок (следующий уже начался), `timeToEnd = context.current.timeToEnd`

3. **Сигнал для проверки:**
   - Используем тот же `series.signalColor` что и для первого шага
   - Проверяем цену на следующем рынке

4. **Отмена валидации:**
   - Если рынок валидации уже прошел или потеряли его - отменяем валидацию (`rejected`)
   - Не покупаем хедж, но серия продолжается

