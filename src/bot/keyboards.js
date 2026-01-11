const { Markup } = require('telegraf');

/**
 * Главное меню
 */
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Сигналы', 'signals')],
  ]);
}

/**
 * Меню сигналов
 */
function signalsMenu(userSettings) {
  const ethEnabled = userSettings?.signals?.eth3candles || false;
  const btcEnabled = userSettings?.signals?.btc3candles || false;

  const ethText = ethEnabled ? '🔔 3 свечи ETH (вкл)' : '🔕 3 свечи ETH (выкл)';
  const btcText = btcEnabled ? '🔔 3 свечи BTC (вкл)' : '🔕 3 свечи BTC (выкл)';

  return Markup.inlineKeyboard([
    [Markup.button.callback(ethText, 'toggle_eth')],
    [Markup.button.callback(btcText, 'toggle_btc')],
    [Markup.button.callback('◀️ Назад', 'back_to_main')],
  ]);
}

module.exports = {
  mainMenu,
  signalsMenu,
};

