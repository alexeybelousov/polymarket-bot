# Деплой Polymarket Bot

## Вариант 1: VPS (рекомендуется)

Подойдёт любой VPS: DigitalOcean, Hetzner, Timeweb, и т.д.
Минимальные требования: 1 CPU, 512MB RAM, Ubuntu 22.04+

### 1. Подготовка сервера

```bash
# Подключаемся к серверу
ssh root@YOUR_SERVER_IP

# Обновляем систему
apt update && apt upgrade -y

# Устанавливаем Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Устанавливаем pnpm
npm install -g pnpm

# Устанавливаем PM2 (менеджер процессов)
npm install -g pm2

# Устанавливаем git
apt install -y git
```

### 2. Клонируем репозиторий

```bash
# Создаём директорию для приложения
mkdir -p /var/www
cd /var/www

# Клонируем репозиторий
git clone https://github.com/YOUR_USERNAME/polymarket-bot.git
cd polymarket-bot

# Устанавливаем зависимости
pnpm install --prod
```

### 3. Настраиваем переменные окружения

```bash
# Создаём .env файл
cp .env.example .env
nano .env
```

Заполняем:
```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
MONGODB_URI=mongodb://localhost:27017/polymarket-bot
DEBUG=false
```

### 4. Запускаем с PM2

```bash
# Запуск
pm2 start ecosystem.config.js --env production

# Проверяем статус
pm2 status

# Смотрим логи
pm2 logs polymarket-bot

# Автозапуск при перезагрузке сервера
pm2 startup
pm2 save
```

### 5. Полезные команды PM2

```bash
# Перезапуск
pm2 restart polymarket-bot

# Остановка
pm2 stop polymarket-bot

# Логи в реальном времени
pm2 logs polymarket-bot --lines 100

# Мониторинг
pm2 monit
```

---

## Вариант 2: Railway (бесплатно)

### 1. Регистрация
Зайди на [railway.app](https://railway.app) и войди через GitHub.

### 2. Деплой
1. Нажми "New Project" → "Deploy from GitHub repo"
2. Выбери репозиторий `polymarket-bot`
3. Railway автоматически определит Node.js проект

### 3. Переменные окружения
В настройках проекта добавь:
- `TELEGRAM_BOT_TOKEN` = твой токен
- `DEBUG` = false

### 4. Готово!
Railway автоматически задеплоит при каждом push в main.

---

## Вариант 3: Render (бесплатно)

### 1. Регистрация
Зайди на [render.com](https://render.com) и войди через GitHub.

### 2. Создание сервиса
1. New → Background Worker (не Web Service!)
2. Подключи GitHub репозиторий
3. Build Command: `pnpm install`
4. Start Command: `node src/index.js`

### 3. Переменные окружения
Добавь в Environment:
- `TELEGRAM_BOT_TOKEN`
- `DEBUG`

---

## Обновление на сервере (VPS)

```bash
cd /var/www/polymarket-bot
git pull
pnpm install --prod
pm2 restart polymarket-bot
```

## Автоматический деплой (GitHub Actions)

Создай `.github/workflows/deploy.yml` для автоматического деплоя при push.

---

## Мониторинг

### Логи
```bash
# PM2 логи
pm2 logs polymarket-bot

# Или напрямую
tail -f ~/.pm2/logs/polymarket-bot-out.log
```

### Статус бота
Отправь `/start` боту в Telegram - если отвечает, значит работает!

