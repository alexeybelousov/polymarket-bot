# Архитектура валидации покупки (обновленная)

## Изменения

1. **Удаляем `sellStrategy`** - продаем всегда как сейчас (по сигналу за 20 сек)
2. **Переименование:**
   - `buyStrategy: 'validated'` → `'validate'` (валидация перед покупкой)
   - `buyStrategy: 'signal'` → остается (покупаем сразу по сигналу)

---

## 1. АРХИТЕКТУРА ВАЛИДАЦИИ ПОКУПКИ (`buyStrategy: 'validate'`)

### Состояния серии при валидации

```javascript
series.validationState: 'validating' | 'validated' | 'rejected' | null
series.validationHistory: [
  { timestamp: Date, price: Number, matches: Boolean, symbol: '+' | '-' }
]
series.validationEventId: ObjectId  // ID события для обновления
series.validationMarketSlug: String  // Рынок который валидируем
series.lastValidationCheck: Date     // Время последней проверки (для интервала 30 сек)
```

### Процесс валидации

#### Шаг 1: Получение сигнала (`onSignal`)

```
onSignal() → buyStrategy === 'validate':
├─ Создаем серию со статусом 'active'
├─ НЕ вызываем buyStep() (не покупаем сразу)
├─ Устанавливаем:
│  ├─ validationState = 'validating'
│  ├─ validationMarketSlug = nextMarketSlug
│  ├─ validationHistory = []
│  └─ lastValidationCheck = null
├─ Добавляем событие 'validation_started':
│  └─ message: "Валидирую рынок:"
│  └─ validationEventId = event._id
└─ Сохраняем серию
```

#### Шаг 2: Процесс валидации (в `checkSeries`)

```
checkSeries(series):
├─ Если validationState === 'validating':
│  ├─ Получаем контекст для validationMarketSlug
│  ├─ Проверяем timeToEnd:
│  │  ├─ Если timeToEnd <= 60 сек (1 минута до конца)
│  │  │  └─ Принимаем решение (см. Шаг 3)
│  │  └─ Если timeToEnd > 60 сек
│  │     └─ Продолжаем валидацию
│  │
│  ├─ Проверка интервала (каждые 30 сек):
│  │  ├─ Если lastValidationCheck === null
│  │  │  └─ Выполняем проверку (первая проверка)
│  │  ├─ Если прошло >= 30 сек с lastValidationCheck
│  │  │  └─ Выполняем проверку
│  │  └─ Иначе
│  │     └─ Пропускаем (ждем 30 сек)
│  │
│  ├─ Проверка цены:
│  │  ├─ Получаем цену с Polymarket для validationMarketSlug
│  │  ├─ Определяем matches (соответствует ли сигналу):
│  │  │  ├─ Сигнал RED → проверяем цену UP
│  │  │  │  └─ price <= 0.5 → matches = true ('+')
│  │  │  │  └─ price > 0.5 → matches = false ('-')
│  │  │  └─ Сигнал GREEN → проверяем цену DOWN
│  │  │     └─ price <= 0.5 → matches = true ('+')
│  │  │     └─ price > 0.5 → matches = false ('-')
│  │  │
│  │  ├─ Добавляем в validationHistory:
│  │  │  └─ { timestamp: now, price, matches, symbol: matches ? '+' : '-' }
│  │  │
│  │  ├─ Обновляем lastValidationCheck = now
│  │  │
│  │  └─ Обновляем событие validationEventId:
│  │     └─ message: "Валидирую рынок: +++--++++--"
│  │        └─ Ограничиваем длину (например, последние 20 символов)
│  │
│  └─ Проверка условий покупки:
│     ├─ Проверяем последние 10 записей в validationHistory
│     ├─ Если все 10 подряд одинаковые И все '+' (соответствуют сигналу)
│     │  └─ ПОКУПАЕМ (вызываем buyStep)
│     └─ Иначе
│        └─ Продолжаем валидацию
│
└─ Если validationState !== 'validating':
   └─ Продолжаем обычную логику
```

#### Шаг 3: Решение за 1 минуту до конца

```
Если timeToEnd <= 60 сек:
├─ Проверяем последние записи в validationHistory
├─ Если есть 10 подряд '+' → ПОКУПАЕМ
├─ Если нет 10 подряд '+' → НЕ ПОКУПАЕМ
│  ├─ Устанавливаем validationState = 'rejected'
│  ├─ Обновляем событие validationEventId:
│  │  └─ message: "Валидирую рынок: +++--++++-- ❌ Отменено"
│  ├─ Добавляем событие 'validation_rejected':
│  │  └─ message: "Валидация не пройдена, покупка отменена"
│  ├─ Устанавливаем series.status = 'cancelled'
│  ├─ series.endedAt = new Date()
│  ├─ Удаляем из activeSeries
│  └─ Сохраняем серию
```

#### Шаг 4: Покупка после валидации

```
Если валидация успешна (10 подряд '+'):
├─ Устанавливаем validationState = 'validated'
├─ Обновляем событие validationEventId:
│  └─ message: "Валидирую рынок: ++++++++++ ✅ Покупка"
├─ Вызываем buyStep(series)
└─ Продолжаем обычный процесс торговли
```

---

## 2. УДАЛЕНИЕ sellStrategy

### Текущая логика (остается без изменений)

```
За 20 сек до конца:
├─ Проверка отмены сигнала (sellStrategy === 'signal'):
│  ├─ Если currentColor !== series.signalColor
│  │  └─ Вызываем cancelSignal() (продаем все позиции)
│  └─ Если currentColor === series.betColor
│     └─ Вызываем sellHedge() (продаем хедж)
```

### Изменения в коде

```
1. Удалить sellStrategy из конфигов ботов
2. Удалить все проверки sellStrategy === 'signal'
3. Оставить только логику продажи (без проверки стратегии)
4. Удалить sellStrategy из конструктора (строка 100)
```

---

## 3. СТРУКТУРА ДАННЫХ

### TradeSeries - новые поля

```javascript
{
  // ... существующие поля ...
  
  // Валидация покупки
  validationState: {
    type: String,
    enum: ['validating', 'validated', 'rejected'],
    default: null
  },
  validationHistory: [{
    timestamp: Date,
    price: Number,
    matches: Boolean,  // соответствует ли цена сигналу
    symbol: String     // '+' или '-'
  }],
  validationEventId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  validationMarketSlug: String,  // Рынок который валидируем
  lastValidationCheck: Date      // Время последней проверки
}
```

---

## 4. ИЗМЕНЕНИЯ В КОДЕ

### 4.1. `onSignal` (строки 411-421)

```
Текущая логика:
├─ buyStrategy === 'validated' → fallback на 'signal'
└─ buyStrategy === 'signal' → сразу buyStep()

Новая логика:
├─ buyStrategy === 'validate':
│  ├─ Создаем серию БЕЗ покупки
│  ├─ Устанавливаем validationState = 'validating'
│  ├─ Сохраняем validationMarketSlug = nextMarketSlug
│  ├─ Добавляем событие 'validation_started'
│  └─ НЕ вызываем buyStep()
└─ buyStrategy === 'signal':
   └─ Сразу buyStep() (как сейчас)
```

### 4.2. `checkSeries` (строки 1040-1132)

```
Добавить в начало checkSeries():

if (series.validationState === 'validating') {
  // Логика валидации
  await this.validateMarket(series);
  return; // Выходим, не продолжаем обычную логику
}

// Продолжаем обычную логику...
```

### 4.3. Новая функция `validateMarket`

```
async validateMarket(series) {
  1. Получить контекст для validationMarketSlug
  2. Проверить timeToEnd
  3. Проверить интервал (30 сек)
  4. Если нужно - выполнить проверку цены
  5. Обновить событие
  6. Проверить условия покупки
  7. Если нужно - купить или отменить
}
```

### 4.4. Удаление `sellStrategy`

```
1. Удалить из TRADING_CONFIGS (строки 21, 33, 49)
2. Удалить из конструктора (строка 100)
3. Удалить проверки sellStrategy === 'signal' (строки 1058, 1106)
4. Оставить логику продажи без проверки стратегии
```

---

## 5. ЛОГИКА ОПРЕДЕЛЕНИЯ СООТВЕТСТВИЯ ЦЕНЫ

### Функция: `checkPriceMatchesSignal`

```javascript
function checkPriceMatchesSignal(price, signalColor) {
  // Сигнал RED → проверяем цену UP
  if (signalColor === 'red') {
    // Если price <= 0.5 → сигнал подтверждается (RED)
    // Если price > 0.5 → сигнал отменился (GREEN)
    return price <= 0.5;
  }
  
  // Сигнал GREEN → проверяем цену DOWN
  if (signalColor === 'green') {
    // Если price <= 0.5 → сигнал подтверждается (GREEN)
    // Если price > 0.5 → сигнал отменился (RED)
    return price <= 0.5;
  }
  
  return false;
}
```

### Какую цену проверяем?

```
Сигнал RED → проверяем цену UP (betOutcome = 'up')
Сигнал GREEN → проверяем цену DOWN (betOutcome = 'down')

Используем: polymarket.getBuyPrice(polySlug, betOutcome)
```

---

## 6. ОГРАНИЧЕНИЕ ДЛИНЫ СООБЩЕНИЯ

### Стратегия обновления события

```
Вариант 1: Ограничить историю
├─ Хранить только последние 20 записей в validationHistory
└─ В сообщении показывать последние 20 символов

Вариант 2: Обновлять сообщение
├─ Хранить всю историю
└─ В сообщении показывать только последние 20 символов:
   └─ message: "Валидирую рынок: " + history.slice(-20).join('')
```

**Рекомендация:** Вариант 2 - храним всю историю, но в сообщении показываем последние 20 символов.

---

## 7. ВРЕМЕННАЯ ДИАГРАММА (обновленная)

```
Время: 0:00 ──────────────────────────────────────────> 15:00 (закрытие рынка)
       │                                                  │
       │  Получен сигнал RED на рынок 15:00              │
       │  ├─ validationState = 'validating'              │
       │  └─ Событие: "Валидирую рынок:"                 │
       │                                                  │
       │  0:30 - Проверка 1: price = $0.48 → '+'         │
       │  └─ "Валидирую рынок: +"                        │
       │                                                  │
       │  1:00 - Проверка 2: price = $0.49 → '+'         │
       │  └─ "Валидирую рынок: ++"                       │
       │                                                  │
       │  1:30 - Проверка 3: price = $0.52 → '-'        │
       │  └─ "Валидирую рынок: ++-"                       │
       │                                                  │
       │  2:00 - Проверка 4: price = $0.48 → '+'         │
       │  └─ "Валидирую рынок: ++-+"                      │
       │                                                  │
       │  ... (продолжаем каждые 30 сек)                 │
       │                                                  │
       │  10:00 - Проверка 20: price = $0.47 → '+'       │
       │  └─ "Валидирую рынок: ++++++++++" (10 подряд)    │
       │     └─ ПОКУПАЕМ!                                │
       │                                                  │
       │  ИЛИ если не купили:                            │
       │                                                  │
       │  14:00 - timeToEnd = 60 сек                    │
       │  └─ Проверяем последние 10: "++--++++--"       │
       │     └─ Нет 10 подряд '+' → НЕ ПОКУПАЕМ          │
       │        └─ Отменяем серию                        │
       │                                                  │
       └──────────────────────────────────────────────────┘
```

---

## 8. ПРОВЕРКА "10 ПОДРЯД"

### Алгоритм

```javascript
function has10ConsecutiveMatches(history) {
  if (history.length < 10) return false;
  
  // Проверяем последние 10 записей
  const last10 = history.slice(-10);
  
  // Проверяем что все 10 подряд одинаковые И все '+'
  const allMatch = last10.every(h => h.matches === true);
  
  return allMatch;
}
```

### Примеры

```
История: [++++++--++++++]
Последние 10: [++--++++++]
Результат: false (не все подряд '+')

История: [++++++--++++++++++]
Последние 10: [++++++++++]
Результат: true (все 10 подряд '+')
```

---

## 9. ИЗМЕНЕНИЯ В МЕСТАХ КОДА

### Место 1: `onSignal` (строка 411)

```
БЫЛО:
if (this.config.buyStrategy === 'validated') {
  // fallback
  bought = await this.buyStep(series);
} else {
  bought = await this.buyStep(series);
}

СТАНЕТ:
if (this.config.buyStrategy === 'validate') {
  // Начинаем валидацию
  series.validationState = 'validating';
  series.validationMarketSlug = nextMarketSlug;
  // ... создаем событие ...
  // НЕ вызываем buyStep()
} else {
  // buyStrategy === 'signal'
  bought = await this.buyStep(series);
}
```

### Место 2: `checkSeries` (начало функции)

```
ДОБАВИТЬ в начало:
if (series.validationState === 'validating') {
  await this.validateMarket(series);
  return; // Выходим, не продолжаем обычную логику
}
```

### Место 3: Удаление `sellStrategy`

```
УДАЛИТЬ:
- Строка 21: sellStrategy: 'signal'
- Строка 33: sellStrategy: 'signal'
- Строка 49: sellStrategy: 'hold'
- Строка 100: this.config.sellStrategy = ...
- Строка 1058: if (this.config.sellStrategy === 'signal')
- Строка 1106: if (this.config.sellStrategy === 'signal')
```

---

## 10. НОВАЯ ФУНКЦИЯ `validateMarket`

### Структура функции

```javascript
async validateMarket(series) {
  1. Получить контекст для validationMarketSlug
  2. Проверить timeToEnd
  3. Если timeToEnd <= 60 → принимаем решение
  4. Проверить интервал (30 сек)
  5. Если нужно - выполнить проверку цены
  6. Обновить событие (ограничить длину)
  7. Проверить условия покупки (10 подряд '+')
  8. Если нужно - купить или отменить
}
```

---

## 11. ВОПРОСЫ ДЛЯ УТОЧНЕНИЯ

1. **Ограничение длины сообщения:**
   - Показывать последние 20 символов или меньше?
   - Или ограничить историю до 20 записей?

2. **Обновление события:**
   - Обновлять существующее событие или создавать новое каждые N проверок?
   - Как обновлять событие в MongoDB? (найти по ID и обновить message)

3. **Интервал проверки:**
   - Строго каждые 30 секунд или можно при каждом tick() если прошло >= 30 сек?

4. **Отмена серии:**
   - При отмене валидации - статус 'cancelled'?
   - Нужно ли обновлять статистику (cancelledTrades++)?

---

## 12. ПРЕИМУЩЕСТВА ОБНОВЛЕННОЙ АРХИТЕКТУРЫ

1. **Упрощение:**
   - Удален `sellStrategy` - меньше сложности
   - Продажа всегда работает одинаково

2. **Прозрачность валидации:**
   - История видна в таймлайне
   - Понятно почему покупка была или не была

3. **Гибкость:**
   - Легко добавить более сложную логику валидации
   - Можно использовать order book в будущем

4. **Совместимость:**
   - Старая логика (`buyStrategy: 'signal'`) продолжает работать
   - Можно использовать разные стратегии для разных ботов

