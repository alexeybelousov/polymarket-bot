# Схема работы Cooldown механизма

## Общая логика

Cooldown создается после полного проигрыша серии (все шаги исчерпаны) и блокирует торговлю на указанное время (например, 15 минут).

---

## 1. СОЗДАНИЕ COOLDOWN (`createCooldown`)

**Триггер:** Серия проиграна после всех шагов (`series.currentStep >= maxSteps`)

**Процесс:**
```
1. Проверка activeSeries:
   ├─ Если есть cooldown и он АКТИВЕН (endedAt > now)
   │  └─ Возвращаем существующий cooldown
   ├─ Если есть cooldown и он ИСТЕК (endedAt <= now)
   │  └─ Закрываем его (endCooldown) → удаляем из activeSeries
   └─ Если нет cooldown или это обычная серия
      └─ Продолжаем проверку БД

2. Проверка БД:
   ├─ Если есть cooldown и он АКТИВЕН (endedAt > now)
   │  └─ Добавляем в activeSeries → возвращаем
   ├─ Если есть cooldown и он ИСТЕК (endedAt <= now)
   │  └─ Закрываем его (endCooldown)
   └─ Если нет cooldown в БД
      └─ Продолжаем создание

3. Проверка конфига:
   ├─ Если cooldownAfterFullLoss не настроен (0 или null)
   │  └─ Возвращаем null (cooldown не создается)
   └─ Если настроен
      └─ Создаем новый cooldown

4. Создание нового cooldown:
   ├─ Создаем TradeSeries со статусом 'cooldown'
   ├─ Устанавливаем startedAt = now
   ├─ Устанавливаем endedAt = now + cooldownDuration
   ├─ Добавляем событие 'cooldown_started'
   ├─ Сохраняем в БД
   └─ Добавляем в activeSeries
```

---

## 2. ПРОВЕРКА ПРИ ПОЛУЧЕНИИ СИГНАЛА (`onSignal`)

**Триггер:** Получен новый сигнал для торговли

**Процесс:**
```
1. Проверка activeSeries:
   ├─ Если есть cooldown и он АКТИВЕН (endedAt > now)
   │  └─ Пропускаем сигнал (return)
   ├─ Если есть cooldown и он ИСТЕК (endedAt <= now)
   │  └─ Закрываем его (endCooldown) → удаляем из activeSeries → продолжаем
   └─ Если нет cooldown в activeSeries
      └─ Проверяем БД

2. Проверка БД (если нет в activeSeries):
   ├─ Если есть cooldown и он АКТИВЕН (endedAt > now)
   │  └─ Добавляем в activeSeries → пропускаем сигнал (return)
   ├─ Если есть cooldown и он ИСТЕК (endedAt <= now)
   │  └─ Закрываем его (endCooldown) → продолжаем
   └─ Если нет cooldown в БД
      └─ Продолжаем обработку сигнала (создаем новую серию)
```

---

## 3. ЗАГРУЗКА ПРИ СТАРТЕ БОТА (`start`)

**Триггер:** Бот запускается или перезапускается

**Процесс:**
```
1. Загружаем все cooldown серии из БД:
   └─ TradeSeries.find({ botId, status: 'cooldown' })

2. Для каждой cooldown серии:
   ├─ Если АКТИВНА (endedAt > now)
   │  ├─ Добавляем в activeSeries
   │  └─ Логируем оставшееся время
   └─ Если ИСТЕКЛА (endedAt <= now)
      ├─ Закрываем её (endCooldown)
      └─ Логируем завершение
```

---

## 4. ПРОВЕРКА В TICK() (каждые 5 секунд)

**Триггер:** Периодическая проверка (setInterval 5000ms)

**Процесс:**
```
1. Первый проход - проверка истекших cooldown:
   └─ Для каждой серии в activeSeries:
      ├─ Если status === 'cooldown' И endedAt <= now
      │  ├─ Закрываем (endCooldown)
      │  └─ Удаляем из activeSeries
      └─ Иначе - пропускаем

2. Второй проход - проверка обычных серий:
   └─ Для каждой серии в activeSeries:
      ├─ Если status === 'cooldown'
      │  └─ Пропускаем (continue)
      └─ Иначе
         └─ Проверяем серию (checkSeries)
```

---

## 5. ЗАВЕРШЕНИЕ COOLDOWN (`endCooldown`)

**Триггер:** Cooldown истек или нужно закрыть вручную

**Процесс:**
```
1. Проверка статуса:
   └─ Если status !== 'cooldown' → return (ничего не делаем)

2. Обновление серии:
   ├─ Оставляем status = 'cooldown' (для истории - это правильно!)
   ├─ Устанавливаем endedAt = now (обновляем время завершения)
   ├─ Добавляем событие 'cooldown_ended'
   └─ Сохраняем в БД
```

**Примечание:** Статус остается 'cooldown' после завершения - это правильно, так как показывает тип серии. Активность определяется по `endedAt` (если `endedAt > now` - активен, иначе - завершен).

---

## 6. МЕСТА СОЗДАНИЯ COOLDOWN

Cooldown создается в трех местах после полного проигрыша:

1. **resolveMarket → hedge превышает maxSteps:**
   ```
   if (nextStep > maxSteps) {
     // Серия проиграна
     await createCooldown(series.asset);
   }
   ```

2. **resolveMarket → все шаги исчерпаны:**
   ```
   if (series.currentStep >= maxSteps) {
     // Серия проиграна
     await createCooldown(series.asset);
   }
   ```

3. **resolveMarket → следующий шаг превышает maxSteps:**
   ```
   if (nextStep > maxSteps) {
     // Серия проиграна
     await createCooldown(series.asset);
   }
   ```

---

## ПОТЕНЦИАЛЬНЫЕ ПРОБЛЕМЫ

1. **Дублирование проверок:**
   - Проверка в `createCooldown` и `onSignal` похожи
   - Но это необходимо для разных сценариев

2. **Race condition:**
   - Если два сигнала придут одновременно, может быть создано два cooldown
   - **Решение:** Проверка в `createCooldown` предотвращает это (проверяет activeSeries и БД перед созданием)

---

## УЛУЧШЕНИЯ

1. Добавить метрики для отслеживания cooldown (сколько раз создан, сколько раз пропущен сигнал)
2. Добавить более детальное логирование для отладки

