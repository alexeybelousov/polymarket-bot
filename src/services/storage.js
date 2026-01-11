const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../../data/users.json');

// Убедимся что папка data существует
function ensureDataDir() {
  const dataDir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

// Загрузить данные
function loadData() {
  ensureDataDir();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (error) {
    console.error('Error loading data:', error.message);
  }
  return { users: {} };
}

// Сохранить данные
function saveData(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// Получить пользователя
function getUser(telegramId) {
  const data = loadData();
  return data.users[telegramId] || null;
}

// Создать или обновить пользователя
function saveUser(user) {
  const data = loadData();
  data.users[user.telegramId] = {
    ...user,
    updatedAt: new Date().toISOString(),
  };
  saveData(data);
  return data.users[user.telegramId];
}

// Получить или создать пользователя
function getOrCreateUser(telegramId, userData = {}) {
  let user = getUser(telegramId);
  
  if (!user) {
    user = {
      telegramId,
      username: userData.username || null,
      firstName: userData.firstName || null,
      signals: {
        eth3candles: false,
        btc3candles: false,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveUser(user);
    console.log(`👤 New user: ${user.firstName} (${telegramId})`);
  }
  
  return user;
}

// Получить всех пользователей с включённым сигналом
function getUsersWithSignal(signalType) {
  const data = loadData();
  const field = signalType === 'eth' ? 'eth3candles' : 'btc3candles';
  
  return Object.values(data.users).filter(
    (user) => user.signals && user.signals[field] === true
  );
}

// Переключить сигнал
function toggleSignal(telegramId, signalType) {
  const user = getUser(telegramId);
  if (!user) return null;
  
  const field = signalType === 'eth' ? 'eth3candles' : 'btc3candles';
  user.signals[field] = !user.signals[field];
  
  return saveUser(user);
}

module.exports = {
  getUser,
  saveUser,
  getOrCreateUser,
  getUsersWithSignal,
  toggleSignal,
};

