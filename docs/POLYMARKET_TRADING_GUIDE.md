# Руководство по работе с Polymarket API для торгового бота

Полное руководство по интеграции торговли на Polymarket с примерами кода, обработкой ошибок и лучшими практиками.

---

## 📋 Содержание

1. [Установка и настройка](#установка-и-настройка)
2. [Работа с балансом кошелька](#работа-с-балансом-кошелька)
3. [Подключение к Polymarket](#подключение-к-polymarket)
4. [Покупка токенов](#покупка-токенов)
5. [Продажа и закрытие позиций](#продажа-и-закрытие-позиций)
6. [Обработка ошибок и повторы](#обработка-ошибок-и-повторы)
7. [Полные примеры использования](#полные-примеры-использования)

---

## Установка и настройка

### Необходимые зависимости

```json
{
  "dependencies": {
    "@polymarket/clob-client": "^4.14.0",
    "ethers": "^5.7.2",
    "dotenv": "^16.4.7"
  }
}
```

Установка:
```bash
npm install @polymarket/clob-client ethers@^5.7.2 dotenv
```

### Переменные окружения (.env)

Создайте файл `.env` со следующими переменными:

```env
# Ваш кошелек
WALLET_ADDRESS=0xYourWalletAddress
PRIVATE_KEY=your_private_key_64_chars_no_0x_prefix

# Polymarket CLOB API
CLOB_HTTP_URL=https://clob.polymarket.com

# Polygon RPC (можно использовать публичные или свой)
RPC_URL=https://polygon-rpc.com

# USDC контракт на Polygon
USDC_CONTRACT_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174

# Настройки повторов (опционально)
RETRY_LIMIT=3
```

**⚠️ ВАЖНО:** 
- `PRIVATE_KEY` должен быть 64 символа hex без префикса `0x`
- Никогда не коммитьте `.env` файл в git
- Используйте переменные окружения в продакшене

---

## Работа с балансом кошелька

### Получение баланса USDC

Функция для получения баланса USDC на Polygon:

```typescript
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const RPC_URL = process.env.RPC_URL!;
const USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS!;

// ABI для функции balanceOf
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

/**
 * Получает баланс USDC для указанного адреса
 * @param address - Адрес кошелька
 * @returns Баланс в USDC (число)
 */
export const getBalance = async (address: string): Promise<number> => {
    try {
        // Создаем провайдер для подключения к Polygon
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        
        // Создаем контракт USDC
        const usdcContract = new ethers.Contract(
            USDC_CONTRACT_ADDRESS,
            USDC_ABI,
            provider
        );
        
        // Получаем баланс (возвращается в wei, для USDC это 6 decimals)
        const balanceWei = await usdcContract.balanceOf(address);
        
        // Конвертируем в читаемый формат (USDC имеет 6 decimals)
        const balanceUsdc = ethers.utils.formatUnits(balanceWei, 6);
        
        return parseFloat(balanceUsdc);
    } catch (error) {
        console.error(`Ошибка при получении баланса для ${address}:`, error);
        // Возвращаем 0 при ошибке, чтобы не крашить бота
        return 0;
    }
};

// Пример использования
const checkBalance = async () => {
    const walletAddress = process.env.WALLET_ADDRESS!;
    const balance = await getBalance(walletAddress);
    console.log(`Баланс кошелька: ${balance} USDC`);
    
    if (balance < 10) {
        console.warn('⚠️ Низкий баланс! Пополните кошелек.');
    }
};
```

### Проверка достаточности баланса

```typescript
/**
 * Проверяет, достаточно ли баланса для сделки
 * @param requiredAmount - Требуемая сумма в USDC
 * @param walletAddress - Адрес кошелька
 * @returns true если баланса достаточно
 */
export const hasEnoughBalance = async (
    requiredAmount: number,
    walletAddress: string
): Promise<boolean> => {
    const balance = await getBalance(walletAddress);
    const hasEnough = balance >= requiredAmount;
    
    if (!hasEnough) {
        console.warn(
            `Недостаточно баланса. Требуется: ${requiredAmount} USDC, доступно: ${balance} USDC`
        );
    }
    
    return hasEnough;
};
```

---

## Подключение к Polymarket

### Инициализация CLOB клиента

CLOB (Central Limit Order Book) - это API Polymarket для размещения ордеров.

```typescript
import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import * as dotenv from 'dotenv';

dotenv.config();

const WALLET_ADDRESS = process.env.WALLET_ADDRESS!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const CLOB_HTTP_URL = process.env.CLOB_HTTP_URL!;

/**
 * Создает и инициализирует CLOB клиент для работы с Polymarket
 * @returns Настроенный ClobClient
 */
export const createClobClient = async (): Promise<ClobClient> => {
    try {
        // Chain ID для Polygon
        const chainId = 137;
        
        // Создаем кошелек из приватного ключа
        const wallet = new ethers.Wallet(PRIVATE_KEY);
        
        // Создаем начальный клиент без API ключа
        let clobClient = new ClobClient(
            CLOB_HTTP_URL,
            chainId,
            wallet,
            undefined, // API ключ будет создан/получен
            SignatureType.POLY_GNOSIS_SAFE,
            WALLET_ADDRESS
        );
        
        // Пытаемся создать новый API ключ
        // Временно отключаем console.error, так как библиотека может выводить предупреждения
        const originalConsoleError = console.error;
        console.error = function () {};
        
        let apiCredentials = await clobClient.createApiKey();
        
        // Восстанавливаем console.error
        console.error = originalConsoleError;
        
        // Если не удалось создать, пытаемся получить существующий
        if (!apiCredentials.key) {
            apiCredentials = await clobClient.deriveApiKey();
            console.log('✅ API ключ получен из существующего');
        } else {
            console.log('✅ Новый API ключ создан');
        }
        
        // Создаем финальный клиент с API ключом
        clobClient = new ClobClient(
            CLOB_HTTP_URL,
            chainId,
            wallet,
            apiCredentials,
            SignatureType.POLY_GNOSIS_SAFE,
            WALLET_ADDRESS
        );
        
        console.log('✅ CLOB клиент успешно инициализирован');
        return clobClient;
        
    } catch (error) {
        console.error('❌ Ошибка при создании CLOB клиента:', error);
        throw error;
    }
};

// Пример использования
const initClient = async () => {
    try {
        const clobClient = await createClobClient();
        console.log('Клиент готов к работе');
        return clobClient;
    } catch (error) {
        console.error('Не удалось инициализировать клиент:', error);
        process.exit(1);
    }
};
```

### Проверка подключения

```typescript
/**
 * Проверяет работоспособность CLOB клиента
 */
export const testClobConnection = async (clobClient: ClobClient): Promise<boolean> => {
    try {
        // Пытаемся получить информацию о балансе через клиент
        // Это проверит, что API ключ работает
        const user = await clobClient.getUser();
        console.log('✅ Подключение к Polymarket работает');
        return true;
    } catch (error) {
        console.error('❌ Ошибка подключения к Polymarket:', error);
        return false;
    }
};
```

---

## Покупка токенов

### Получение стакана ордеров (Order Book)

Перед покупкой нужно получить текущие цены из стакана ордеров:

```typescript
import { ClobClient } from '@polymarket/clob-client';

/**
 * Получает стакан ордеров для токена
 * @param clobClient - CLOB клиент
 * @param tokenId - ID токена (asset ID) на Polymarket
 * @returns Стакан ордеров с ценами покупки (asks) и продажи (bids)
 */
export const getOrderBook = async (
    clobClient: ClobClient,
    tokenId: string
) => {
    try {
        const orderBook = await clobClient.getOrderBook(tokenId);
        
        // orderBook содержит:
        // - asks: массив ордеров на продажу (от кого мы покупаем)
        // - bids: массив ордеров на покупку (кому мы продаем)
        
        return orderBook;
    } catch (error) {
        console.error(`Ошибка при получении стакана для токена ${tokenId}:`, error);
        throw error;
    }
};
```

### Простая покупка токенов

```typescript
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';

/**
 * Покупает токены на Polymarket
 * @param clobClient - CLOB клиент
 * @param tokenId - ID токена для покупки
 * @param amountUsdc - Сумма в USDC, которую хотите потратить
 * @returns Результат выполнения ордера
 */
export const buyTokens = async (
    clobClient: ClobClient,
    tokenId: string,
    amountUsdc: number
): Promise<any> => {
    try {
        // 1. Получаем стакан ордеров
        const orderBook = await clobClient.getOrderBook(tokenId);
        
        if (!orderBook.asks || orderBook.asks.length === 0) {
            throw new Error('Нет доступных ордеров на покупку');
        }
        
        // 2. Находим лучшую цену (минимальную среди asks)
        const bestAsk = orderBook.asks.reduce((min, ask) => {
            return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
        }, orderBook.asks[0]);
        
        const bestPrice = parseFloat(bestAsk.price);
        console.log(`Лучшая цена покупки: ${bestPrice}`);
        
        // 3. Определяем размер ордера
        // Если хотим купить на всю сумму, но доступно меньше - берем доступное
        const availableAmount = parseFloat(bestAsk.size) * bestPrice;
        const orderAmount = Math.min(amountUsdc, availableAmount);
        
        // 4. Создаем параметры ордера
        const orderParams = {
            side: Side.BUY,
            tokenID: tokenId,
            amount: orderAmount, // Сумма в USDC
            price: bestPrice,    // Цена за токен
        };
        
        console.log('Параметры ордера:', orderParams);
        
        // 5. Создаем подписанный ордер
        const signedOrder = await clobClient.createMarketOrder(orderParams);
        
        // 6. Размещаем ордер (FOK = Fill or Kill - исполнить полностью или отменить)
        const response = await clobClient.postOrder(signedOrder, OrderType.FOK);
        
        if (response.success) {
            console.log('✅ Ордер успешно размещен:', response);
            return response;
        } else {
            throw new Error(`Ордер не выполнен: ${JSON.stringify(response)}`);
        }
        
    } catch (error) {
        console.error('Ошибка при покупке токенов:', error);
        throw error;
    }
};
```

### Покупка с проверкой баланса и цены

```typescript
/**
 * Покупает токены с проверками и обработкой ошибок
 * @param clobClient - CLOB клиент
 * @param tokenId - ID токена
 * @param amountUsdc - Сумма в USDC
 * @param walletAddress - Адрес кошелька
 * @param maxPriceSlippage - Максимальное отклонение цены (по умолчанию 0.05 = 5%)
 */
export const buyTokensSafe = async (
    clobClient: ClobClient,
    tokenId: string,
    amountUsdc: number,
    walletAddress: string,
    maxPriceSlippage: number = 0.05
): Promise<any> => {
    // 1. Проверяем баланс
    const balance = await getBalance(walletAddress);
    if (balance < amountUsdc) {
        throw new Error(
            `Недостаточно баланса. Требуется: ${amountUsdc} USDC, доступно: ${balance} USDC`
        );
    }
    
    // 2. Получаем стакан
    const orderBook = await clobClient.getOrderBook(tokenId);
    
    if (!orderBook.asks || orderBook.asks.length === 0) {
        throw new Error('Нет доступных ордеров на покупку');
    }
    
    // 3. Находим лучшую цену
    const bestAsk = orderBook.asks.reduce((min, ask) => {
        return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
    }, orderBook.asks[0]);
    
    const bestPrice = parseFloat(bestAsk.price);
    
    // 4. Проверяем, что цена не слишком высокая (опционально)
    // Например, если вы знаете ожидаемую цену
    // if (bestPrice > expectedPrice * (1 + maxPriceSlippage)) {
    //     throw new Error(`Цена слишком высокая: ${bestPrice}`);
    // }
    
    // 5. Определяем размер ордера
    const availableAmount = parseFloat(bestAsk.size) * bestPrice;
    const orderAmount = Math.min(amountUsdc, availableAmount);
    
    if (orderAmount <= 0) {
        throw new Error('Неверный размер ордера');
    }
    
    // 6. Создаем и размещаем ордер
    const orderParams = {
        side: Side.BUY,
        tokenID: tokenId,
        amount: orderAmount,
        price: bestPrice,
    };
    
    const signedOrder = await clobClient.createMarketOrder(orderParams);
    const response = await clobClient.postOrder(signedOrder, OrderType.FOK);
    
    if (!response.success) {
        throw new Error(`Ордер не выполнен: ${JSON.stringify(response)}`);
    }
    
    console.log(`✅ Куплено токенов на сумму ${orderAmount} USDC по цене ${bestPrice}`);
    return response;
};
```

---

## Продажа и закрытие позиций

### Получение текущих позиций

Перед продажей нужно узнать, какие позиции у вас есть:

```typescript
import axios from 'axios';

/**
 * Получает текущие позиции кошелька на Polymarket
 * @param walletAddress - Адрес кошелька
 * @returns Массив позиций
 */
export const getPositions = async (walletAddress: string): Promise<any[]> => {
    try {
        const response = await axios.get(
            `https://data-api.polymarket.com/positions?user=${walletAddress}`,
            {
                timeout: 10000,
            }
        );
        
        if (!Array.isArray(response.data)) {
            return [];
        }
        
        return response.data;
    } catch (error) {
        console.error('Ошибка при получении позиций:', error);
        return [];
    }
};

/**
 * Находит позицию по ID токена
 * @param walletAddress - Адрес кошелька
 * @param tokenId - ID токена
 * @returns Позиция или undefined
 */
export const findPosition = async (
    walletAddress: string,
    tokenId: string
): Promise<any | undefined> => {
    const positions = await getPositions(walletAddress);
    return positions.find((pos) => pos.asset === tokenId);
};
```

### Простая продажа позиции

```typescript
/**
 * Продает токены на Polymarket
 * @param clobClient - CLOB клиент
 * @param tokenId - ID токена для продажи
 * @param amount - Количество токенов для продажи
 * @returns Результат выполнения ордера
 */
export const sellTokens = async (
    clobClient: ClobClient,
    tokenId: string,
    amount: number
): Promise<any> => {
    try {
        // 1. Получаем стакан ордеров
        const orderBook = await clobClient.getOrderBook(tokenId);
        
        if (!orderBook.bids || orderBook.bids.length === 0) {
            throw new Error('Нет доступных ордеров на продажу');
        }
        
        // 2. Находим лучшую цену (максимальную среди bids)
        const bestBid = orderBook.bids.reduce((max, bid) => {
            return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
        }, orderBook.bids[0]);
        
        const bestPrice = parseFloat(bestBid.price);
        console.log(`Лучшая цена продажи: ${bestPrice}`);
        
        // 3. Определяем размер ордера
        // Если хотим продать больше, чем доступно - берем доступное
        const availableSize = parseFloat(bestBid.size);
        const orderAmount = Math.min(amount, availableSize);
        
        // 4. Создаем параметры ордера
        const orderParams = {
            side: Side.SELL,
            tokenID: tokenId,
            amount: orderAmount, // Количество токенов
            price: bestPrice,    // Цена за токен
        };
        
        console.log('Параметры ордера:', orderParams);
        
        // 5. Создаем подписанный ордер
        const signedOrder = await clobClient.createMarketOrder(orderParams);
        
        // 6. Размещаем ордер
        const response = await clobClient.postOrder(signedOrder, OrderType.FOK);
        
        if (response.success) {
            console.log('✅ Ордер на продажу успешно размещен:', response);
            return response;
        } else {
            throw new Error(`Ордер не выполнен: ${JSON.stringify(response)}`);
        }
        
    } catch (error) {
        console.error('Ошибка при продаже токенов:', error);
        throw error;
    }
};
```

### Закрытие всей позиции

```typescript
/**
 * Закрывает всю позицию по токену (продает все токены)
 * @param clobClient - CLOB клиент
 * @param tokenId - ID токена
 * @param walletAddress - Адрес кошелька
 * @returns Результат выполнения
 */
export const closePosition = async (
    clobClient: ClobClient,
    tokenId: string,
    walletAddress: string
): Promise<any> => {
    try {
        // 1. Находим позицию
        const position = await findPosition(walletAddress, tokenId);
        
        if (!position) {
            throw new Error(`Позиция по токену ${tokenId} не найдена`);
        }
        
        const positionSize = position.size;
        console.log(`Размер позиции: ${positionSize} токенов`);
        
        if (positionSize <= 0) {
            throw new Error('Позиция уже закрыта или пуста');
        }
        
        // 2. Продаем всю позицию
        return await sellTokens(clobClient, tokenId, positionSize);
        
    } catch (error) {
        console.error('Ошибка при закрытии позиции:', error);
        throw error;
    }
};
```

### Продажа с частичным закрытием

```typescript
/**
 * Продает часть позиции
 * @param clobClient - CLOB клиент
 * @param tokenId - ID токена
 * @param walletAddress - Адрес кошелька
 * @param percentage - Процент позиции для продажи (0-100)
 */
export const sellPartialPosition = async (
    clobClient: ClobClient,
    tokenId: string,
    walletAddress: string,
    percentage: number
): Promise<any> => {
    if (percentage < 0 || percentage > 100) {
        throw new Error('Процент должен быть от 0 до 100');
    }
    
    const position = await findPosition(walletAddress, tokenId);
    
    if (!position) {
        throw new Error(`Позиция по токену ${tokenId} не найдена`);
    }
    
    const positionSize = position.size;
    const amountToSell = (positionSize * percentage) / 100;
    
    console.log(`Продаем ${percentage}% позиции: ${amountToSell} из ${positionSize} токенов`);
    
    return await sellTokens(clobClient, tokenId, amountToSell);
};
```

---

## Обработка ошибок и повторы

### Универсальная функция с повторами

```typescript
/**
 * Выполняет функцию с повторами при ошибке
 * @param fn - Функция для выполнения
 * @param maxRetries - Максимальное количество попыток
 * @param delay - Задержка между попытками (мс)
 * @param backoffMultiplier - Множитель для экспоненциальной задержки
 */
export const retryWithBackoff = async <T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 2000,
    backoffMultiplier: number = 1.5
): Promise<T> => {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error as Error;
            const isLastAttempt = attempt === maxRetries;
            
            if (isLastAttempt) {
                console.error(
                    `❌ Все попытки исчерпаны (${maxRetries}). Последняя ошибка:`,
                    lastError.message
                );
                throw lastError;
            }
            
            const currentDelay = delay * Math.pow(backoffMultiplier, attempt - 1);
            console.warn(
                `⚠️ Попытка ${attempt}/${maxRetries} не удалась. Повтор через ${currentDelay}мс...`
            );
            
            await new Promise((resolve) => setTimeout(resolve, currentDelay));
        }
    }
    
    throw lastError || new Error('Неизвестная ошибка');
};
```

### Покупка с повторами

```typescript
/**
 * Покупает токены с автоматическими повторами при ошибке
 */
export const buyTokensWithRetry = async (
    clobClient: ClobClient,
    tokenId: string,
    amountUsdc: number,
    walletAddress: string,
    maxRetries: number = 3
): Promise<any> => {
    return retryWithBackoff(
        async () => {
            return await buyTokensSafe(clobClient, tokenId, amountUsdc, walletAddress);
        },
        maxRetries,
        2000, // Начальная задержка 2 секунды
        1.5   // Увеличиваем задержку в 1.5 раза каждый раз
    );
};
```

### Продажа с повторами и частичным исполнением

```typescript
/**
 * Продает токены с повторами, обрабатывая частичное исполнение
 */
export const sellTokensWithRetry = async (
    clobClient: ClobClient,
    tokenId: string,
    totalAmount: number,
    maxRetries: number = 3
): Promise<any> => {
    let remaining = totalAmount;
    let retry = 0;
    
    while (remaining > 0 && retry < maxRetries) {
        try {
            // Получаем стакан
            const orderBook = await clobClient.getOrderBook(tokenId);
            
            if (!orderBook.bids || orderBook.bids.length === 0) {
                throw new Error('Нет доступных ордеров на продажу');
            }
            
            // Находим лучшую цену
            const bestBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);
            
            const bestPrice = parseFloat(bestBid.price);
            const availableSize = parseFloat(bestBid.size);
            
            // Определяем размер ордера
            const orderAmount = Math.min(remaining, availableSize);
            
            if (orderAmount <= 0) {
                console.log('Неверный размер ордера - завершаем');
                break;
            }
            
            // Создаем и размещаем ордер
            const orderParams = {
                side: Side.SELL,
                tokenID: tokenId,
                amount: orderAmount,
                price: bestPrice,
            };
            
            const signedOrder = await clobClient.createMarketOrder(orderParams);
            const response = await clobClient.postOrder(signedOrder, OrderType.FOK);
            
            if (response.success) {
                console.log(`✅ Продано ${orderAmount} токенов по цене ${bestPrice}`);
                remaining -= orderAmount;
                retry = 0; // Сбрасываем счетчик при успехе
                
                // Небольшая задержка после успешного ордера
                await new Promise((resolve) => setTimeout(resolve, 500));
            } else {
                throw new Error(`Ордер не выполнен: ${JSON.stringify(response)}`);
            }
            
        } catch (error) {
            retry += 1;
            console.error(
                `Ошибка при продаже (попытка ${retry}/${maxRetries}):`,
                error
            );
            
            if (retry >= maxRetries) {
                throw new Error(
                    `Не удалось продать токены после ${maxRetries} попыток. Осталось: ${remaining}`
                );
            }
            
            // Задержка перед повтором
            await new Promise((resolve) => setTimeout(resolve, 2000 * retry));
        }
    }
    
    if (remaining > 0) {
        console.warn(`⚠️ Не удалось продать все токены. Осталось: ${remaining}`);
    }
    
    return { success: true, remaining };
};
```

### Обработка специфичных ошибок

```typescript
/**
 * Обрабатывает специфичные ошибки Polymarket
 */
export const handlePolymarketError = (error: any): void => {
    if (error.message) {
        // Недостаточно баланса
        if (error.message.includes('balance') || error.message.includes('insufficient')) {
            console.error('❌ Ошибка: Недостаточно баланса');
            // Можно отправить уведомление или логировать
        }
        
        // Проблемы с ликвидностью
        if (error.message.includes('liquidity') || error.message.includes('No bids') || error.message.includes('No asks')) {
            console.error('❌ Ошибка: Недостаточно ликвидности на рынке');
        }
        
        // Проблемы с API
        if (error.message.includes('timeout') || error.message.includes('network')) {
            console.error('❌ Ошибка: Проблемы с сетью или API');
        }
        
        // Проблемы с подписью
        if (error.message.includes('signature') || error.message.includes('sign')) {
            console.error('❌ Ошибка: Проблемы с подписью транзакции');
        }
    }
};
```

---

## Полные примеры использования

### Пример 1: Простой торговый бот

```typescript
import { createClobClient } from './clobClient';
import { getBalance } from './balance';
import { buyTokensWithRetry, closePosition } from './trading';
import { findPosition } from './positions';

// Конфигурация
const WALLET_ADDRESS = process.env.WALLET_ADDRESS!;
const TOKEN_ID = '0xYourTokenId'; // ID токена на Polymarket

async function tradingBot() {
    try {
        // 1. Инициализируем клиент
        console.log('Инициализация клиента...');
        const clobClient = await createClobClient();
        
        // 2. Проверяем баланс
        const balance = await getBalance(WALLET_ADDRESS);
        console.log(`Текущий баланс: ${balance} USDC`);
        
        if (balance < 10) {
            console.warn('⚠️ Низкий баланс!');
            return;
        }
        
        // 3. Проверяем, есть ли уже позиция
        const existingPosition = await findPosition(WALLET_ADDRESS, TOKEN_ID);
        
        if (existingPosition) {
            console.log('Найдена существующая позиция. Закрываем...');
            await closePosition(clobClient, TOKEN_ID, WALLET_ADDRESS);
        }
        
        // 4. Покупаем новую позицию (10% от баланса)
        const tradeAmount = balance * 0.1;
        console.log(`Покупаем токены на сумму: ${tradeAmount} USDC`);
        
        await buyTokensWithRetry(
            clobClient,
            TOKEN_ID,
            tradeAmount,
            WALLET_ADDRESS
        );
        
        console.log('✅ Торговля завершена успешно');
        
    } catch (error) {
        console.error('❌ Ошибка в торговом боте:', error);
        handlePolymarketError(error);
    }
}

// Запуск
tradingBot();
```

### Пример 2: Бот с логикой на основе сигналов

```typescript
interface TradingSignal {
    action: 'BUY' | 'SELL' | 'HOLD';
    tokenId: string;
    confidence: number; // 0-1
}

async function signalBasedBot(signal: TradingSignal) {
    const clobClient = await createClobClient();
    const balance = await getBalance(WALLET_ADDRESS);
    
    if (signal.action === 'BUY') {
        // Размер позиции зависит от уверенности
        const positionSize = balance * 0.1 * signal.confidence;
        
        console.log(`Сигнал на покупку. Размер позиции: ${positionSize} USDC`);
        
        await buyTokensWithRetry(
            clobClient,
            signal.tokenId,
            positionSize,
            WALLET_ADDRESS
        );
        
    } else if (signal.action === 'SELL') {
        const position = await findPosition(WALLET_ADDRESS, signal.tokenId);
        
        if (position) {
            console.log('Сигнал на продажу. Закрываем позицию...');
            await closePosition(clobClient, signal.tokenId, WALLET_ADDRESS);
        } else {
            console.log('Нет позиции для продажи');
        }
    }
}
```

### Пример 3: Бот с мониторингом позиций

```typescript
async function monitorAndTrade() {
    const clobClient = await createClobClient();
    const positions = await getPositions(WALLET_ADDRESS);
    
    console.log(`Найдено позиций: ${positions.length}`);
    
    for (const position of positions) {
        console.log(`Позиция: ${position.title || position.asset}`);
        console.log(`  Размер: ${position.size}`);
        console.log(`  Текущая цена: ${position.curPrice}`);
        console.log(`  PnL: ${position.cashPnl} USDC (${position.percentPnl}%)`);
        
        // Пример: закрываем позиции с убытком больше 10%
        if (position.percentPnl < -10) {
            console.log('⚠️ Закрываем убыточную позицию');
            await closePosition(clobClient, position.asset, WALLET_ADDRESS);
        }
    }
}
```

---

## Полезные ссылки и ресурсы

- **Polymarket CLOB Client**: https://github.com/Polymarket/clob-client
- **Polygon RPC**: https://polygon-rpc.com
- **USDC на Polygon**: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- **Polymarket Data API**: https://data-api.polymarket.com

---

## Важные замечания

1. **Безопасность**: Никогда не храните приватные ключи в коде или публичных репозиториях
2. **Тестирование**: Всегда тестируйте на небольших суммах перед реальной торговлей
3. **Лимиты**: Учитывайте лимиты API и добавляйте задержки между запросами
4. **Мониторинг**: Логируйте все операции для отладки и аудита
5. **Ошибки**: Всегда обрабатывайте ошибки и предусматривайте краш-сценарии

---

## Чеклист перед запуском

- [ ] Установлены все зависимости
- [ ] Настроен `.env` файл с правильными значениями
- [ ] Кошелек пополнен USDC на Polygon
- [ ] Протестировано получение баланса
- [ ] Протестировано подключение к CLOB API
- [ ] Протестирована покупка на небольшой сумме
- [ ] Протестирована продажа на небольшой сумме
- [ ] Настроено логирование
- [ ] Добавлена обработка ошибок

---

**Удачи в торговле! 🚀**

