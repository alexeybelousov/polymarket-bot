# Деплой Polymarket Bot на VPS (Ubuntu 22.04)

**Репозиторий:** https://github.com/alexeybelousov/polymarket-bot

## Требования
- VPS с Ubuntu 22.04+
- Минимум: 1 CPU, 512MB RAM
- SSH доступ

---

## Шаг 1: Подключение к серверу

```bash
ssh root@IP_ТВОЕГО_СЕРВЕРА
```

---

## Шаг 2: Установка зависимостей

```bash
# Обновление системы
apt update && apt upgrade -y

# Установка Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Проверка версии
node -v  # должно быть v22.x.x

# Установка pnpm
npm install -g pnpm

# Установка PM2 (менеджер процессов)
npm install -g pm2

# Установка git (обычно уже есть)
apt install -y git
```

---

## Шаг 3: Клонирование проекта

```bash
# Создаём директорию
mkdir -p /var/www
cd /var/www

# Клонируем репозиторий
git clone https://github.com/alexeybelousov/polymarket-bot.git

# Переходим в папку
cd polymarket-bot

# Устанавливаем зависимости
pnpm install --prod
```

---

## Шаг 4: Настройка переменных окружения

```bash
# Создаём .env из примера
cp .env.example .env

# Открываем редактор
nano .env
```

Заполни файл:
```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
MONGODB_URI=mongodb://localhost:27017/polymarket-bot
DEBUG=false
```

Сохранить и выйти:
- `Ctrl+O` → `Enter` (сохранить)
- `Ctrl+X` (выйти)

---

## Шаг 5: Запуск бота

```bash
# Запуск через PM2
pm2 start ecosystem.config.js --env production

# Проверка статуса
pm2 status

# Просмотр логов
pm2 logs polymarket-bot
```

---

## Шаг 6: Автозапуск при перезагрузке

```bash
# Сохраняем конфигурацию PM2
pm2 save

# Настраиваем автозапуск
pm2 startup
# PM2 покажет команду - выполни её!
```

---

## Готово! 🎉

Проверь бота - отправь `/start` в Telegram.

---

## Полезные команды PM2

```bash
# Статус всех процессов
pm2 status

# Логи в реальном времени
pm2 logs polymarket-bot

# Последние 100 строк логов
pm2 logs polymarket-bot --lines 100

# Перезапуск бота
pm2 restart polymarket-bot

# Остановка бота
pm2 stop polymarket-bot

# Удаление из PM2
pm2 delete polymarket-bot

# Мониторинг ресурсов
pm2 monit
```

---

## Обновление бота

Когда запушишь новый код на GitHub:

```bash
cd /var/www/polymarket-bot
git pull
pnpm install --prod
pm2 restart polymarket-bot
```

---

## Troubleshooting

### Бот не отвечает
```bash
# Проверь статус
pm2 status

# Посмотри логи на ошибки
pm2 logs polymarket-bot --lines 200
```

### Ошибка "TELEGRAM_BOT_TOKEN is not set"
```bash
# Проверь что .env существует
cat .env

# Убедись что токен правильный
nano .env
```

### Перезапуск после изменения .env
```bash
pm2 restart polymarket-bot
```
