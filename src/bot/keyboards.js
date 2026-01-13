const { Markup } = require('telegraf');

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Сигналы', 'signals')],
    // [Markup.button.callback('💰 Торговля', 'trading')], // Временно скрыто
  ]);
}

function signalsMenu(userSettings) {
  const s = userSettings?.signals || {};
  const btn = (enabled, text) => enabled ? `🔔 ${text}` : `🔕 ${text}`;

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(btn(s.eth3candles, 'ETH 3с'), 'toggle_eth_3'),
      Markup.button.callback(btn(s.eth2candles, 'ETH 2с'), 'toggle_eth_2'),
    ],
    [
      Markup.button.callback(btn(s.btc3candles, 'BTC 3с'), 'toggle_btc_3'),
      Markup.button.callback(btn(s.btc2candles, 'BTC 2с'), 'toggle_btc_2'),
    ],
    [Markup.button.callback('◀️ Назад', 'back_to_main')],
  ]);
}

function tradingMenu(userSettings, stats) {
  const s = userSettings?.signals || {};
  const tradingEnabled = s.tradingNotifications;
  const btnText = tradingEnabled ? '🔔 Уведомления (вкл)' : '🔕 Уведомления (выкл)';

  return Markup.inlineKeyboard([
    [Markup.button.callback(btnText, 'toggle_trading')],
    [Markup.button.callback('◀️ Назад', 'back_to_main')],
  ]);
}

module.exports = {
  mainMenu,
  signalsMenu,
  tradingMenu,
};
