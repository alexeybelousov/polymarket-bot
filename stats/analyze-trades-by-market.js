const fs = require('fs');

// Читаем данные
const data = JSON.parse(fs.readFileSync(__dirname + '/data.json', 'utf8'));

// Находим все уникальные botId
const allBotIds = [...new Set(data.map(s => s.botId))];
console.log('Найденные боты в данных:', allBotIds);
console.log();

// Группируем сделки по рынкам (signalMarketSlug - рынок где был сигнал)
const byMarket = {};

data.forEach(series => {
  const marketKey = series.signalMarketSlug;
  if (!marketKey) return;
  
  if (!byMarket[marketKey]) {
    byMarket[marketKey] = {
      market: marketKey,
      asset: series.asset,
      signalColor: series.signalColor,
    };
    // Инициализируем массивы для всех ботов
    allBotIds.forEach(botId => {
      byMarket[marketKey][botId] = [];
    });
  }
  
  if (allBotIds.includes(series.botId)) {
    byMarket[marketKey][series.botId].push(series);
  }
});

// Находим рынки с bot2 и bot3 (или другими ботами для сравнения)
const targetBots = ['bot2', 'bot3'];
const availableBots = targetBots.filter(botId => allBotIds.includes(botId));

console.log('='.repeat(100));
console.log('АНАЛИЗ СДЕЛОК ПО РЫНКАМ');
console.log('='.repeat(100));
console.log(`Ищем рынки с ботами: ${targetBots.join(', ')}`);
console.log(`Доступные боты: ${availableBots.join(', ')}`);
console.log();

if (availableBots.length < 2) {
  console.log(`⚠️  В данных нет обоих ботов (bot2 и bot3) для сравнения.`);
  console.log(`Доступные боты: ${allBotIds.join(', ')}`);
  console.log();
  console.log('Показываю статистику по всем доступным ботам:');
  console.log();
  
  allBotIds.forEach(botId => {
    const botMarkets = Object.keys(byMarket).filter(key => 
      byMarket[key][botId] && byMarket[key][botId].length > 0
    );
    
    const botSeries = botMarkets.flatMap(key => byMarket[key][botId]);
    
    const totalInvested = botSeries.reduce((sum, s) => sum + (s.totalInvested || 0), 0);
    const totalPnl = botSeries.reduce((sum, s) => sum + (s.totalPnL || 0), 0);
    const wins = botSeries.filter(s => s.status === 'won').length;
    const losses = botSeries.filter(s => s.status === 'lost').length;
    const cancelled = botSeries.filter(s => s.status === 'cancelled').length;
    const active = botSeries.filter(s => s.status === 'active').length;
    
    console.log(`${botId.toUpperCase()}:`);
    console.log(`  Рынков: ${botMarkets.length}`);
    console.log(`  Всего сделок: ${botSeries.length}`);
    console.log(`  Инвестировано: $${totalInvested.toFixed(2)}`);
    console.log(`  P&L: $${totalPnl.toFixed(2)}`);
    console.log(`  Побед: ${wins}, Поражений: ${losses}, Отменено: ${cancelled}, Активных: ${active}`);
    if (wins + losses > 0) {
      console.log(`  Win Rate: ${(wins / (wins + losses) * 100).toFixed(2)}%`);
    }
    console.log();
  });
  
  // Если есть хотя бы 2 бота, показываем сравнение
  if (allBotIds.length >= 2) {
    console.log('='.repeat(100));
    console.log('СРАВНЕНИЕ ВСЕХ ДОСТУПНЫХ БОТОВ:');
    console.log('='.repeat(100));
    
    // Находим рынки, где торговали несколько ботов
    const multiBotMarkets = Object.keys(byMarket).filter(key => {
      const botsOnMarket = allBotIds.filter(botId => 
        byMarket[key][botId] && byMarket[key][botId].length > 0
      );
      return botsOnMarket.length >= 2;
    });
    
    console.log(`Рынков с несколькими ботами: ${multiBotMarkets.length}`);
    console.log();
    
    if (multiBotMarkets.length > 0) {
      console.log('ТАБЛИЦА СРАВНЕНИЯ СДЕЛОК НА ОДИНАКОВЫХ РЫНКАХ:');
      console.log('='.repeat(150));
      console.log();
      
      const table = [];
      
      multiBotMarkets.forEach(marketKey => {
        const market = byMarket[marketKey];
        
        // Находим все боты на этом рынке
        const botsOnMarket = allBotIds.filter(botId => 
          market[botId] && market[botId].length > 0
        );
        
        // Создаем строки для сравнения
        const maxSeries = Math.max(...botsOnMarket.map(botId => market[botId].length));
        
        for (let i = 0; i < maxSeries; i++) {
          const row = {
            market: marketKey.substring(0, 40),
            asset: market.asset,
            signalColor: market.signalColor,
          };
          
          allBotIds.forEach(botId => {
            const series = market[botId] && market[botId][i] ? market[botId][i] : null;
            row[`${botId}_id`] = series?._id?.substring(0, 12) || '-';
            row[`${botId}_status`] = series?.status || '-';
            row[`${botId}_steps`] = series?.currentStep || 0;
            row[`${botId}_invested`] = series?.totalInvested?.toFixed(2) || '0.00';
            row[`${botId}_pnl`] = series?.totalPnL?.toFixed(2) || '0.00';
            row[`${botId}_result`] = series?.status === 'won' ? 'WIN' : series?.status === 'lost' ? 'LOSS' : series?.status || '-';
          });
          
          table.push(row);
        }
      });
      
      // Заголовок таблицы
      let header = 'Рынок'.padEnd(42) + 'Asset'.padEnd(6) + 'Signal'.padEnd(7);
      allBotIds.forEach(botId => {
        header += `${botId} ID`.padEnd(15) + `${botId} Status`.padEnd(13) + `${botId} Steps`.padEnd(12) + `${botId} $`.padEnd(11) + `${botId} P&L`.padEnd(11) + `${botId} Result`.padEnd(13);
      });
      console.log(header);
      console.log('-'.repeat(150));
      
      // Выводим строки
      table.forEach(row => {
        let line = row.market.padEnd(42) + row.asset.padEnd(6) + row.signalColor.padEnd(7);
        allBotIds.forEach(botId => {
          line += row[`${botId}_id`].padEnd(15) + 
                  row[`${botId}_status`].padEnd(13) + 
                  String(row[`${botId}_steps`]).padEnd(12) + 
                  row[`${botId}_invested`].padEnd(11) + 
                  row[`${botId}_pnl`].padEnd(11) + 
                  row[`${botId}_result`].padEnd(13);
        });
        console.log(line);
      });
      
      // Статистика
      console.log();
      console.log('='.repeat(100));
      console.log('СТАТИСТИКА ПО РЫНКАМ С НЕСКОЛЬКИМИ БОТАМИ:');
      console.log('='.repeat(100));
      
      allBotIds.forEach(botId => {
        const botSeries = table.map(r => {
          const id = r[`${botId}_id`];
          if (id === '-') return null;
          return {
            invested: parseFloat(r[`${botId}_invested`]),
            pnl: parseFloat(r[`${botId}_pnl`]),
            result: r[`${botId}_result`],
          };
        }).filter(s => s !== null);
        
        if (botSeries.length > 0) {
          const totalInvested = botSeries.reduce((sum, s) => sum + s.invested, 0);
          const totalPnl = botSeries.reduce((sum, s) => sum + s.pnl, 0);
          const wins = botSeries.filter(s => s.result === 'WIN').length;
          const losses = botSeries.filter(s => s.result === 'LOSS').length;
          
          console.log(`${botId.toUpperCase()}: ${botSeries.length} сделок, инвестировано: $${totalInvested.toFixed(2)}, P&L: $${totalPnl.toFixed(2)}, Побед: ${wins}, Поражений: ${losses}`);
          if (wins + losses > 0) {
            console.log(`  Win Rate: ${(wins / (wins + losses) * 100).toFixed(2)}%`);
          }
        }
      });
    }
  }
  
} else {
  // Есть оба бота для сравнения
  const commonMarkets = Object.keys(byMarket).filter(key => {
    const hasBot2 = byMarket[key].bot2 && byMarket[key].bot2.length > 0;
    const hasBot3 = byMarket[key].bot3 && byMarket[key].bot3.length > 0;
    return hasBot2 && hasBot3;
  });
  
  console.log(`Рынков с обеими ботами (bot2 и bot3): ${commonMarkets.length}`);
  console.log();
  
  if (commonMarkets.length > 0) {
    console.log('ТАБЛИЦА СРАВНЕНИЯ СДЕЛОК НА ОДИНАКОВЫХ РЫНКАХ:');
    console.log('='.repeat(150));
    console.log();
    
    const table = [];
    
    commonMarkets.forEach(marketKey => {
      const market = byMarket[marketKey];
      const bot2Series = market.bot2 || [];
      const bot3Series = market.bot3 || [];
      
      const maxSeries = Math.max(bot2Series.length, bot3Series.length);
      
      for (let i = 0; i < maxSeries; i++) {
        const s2 = bot2Series[i] || null;
        const s3 = bot3Series[i] || null;
        
        const row = {
          market: marketKey.substring(0, 40),
          asset: market.asset,
          signalColor: market.signalColor,
          bot2_id: s2?._id?.substring(0, 12) || '-',
          bot2_status: s2?.status || '-',
          bot2_steps: s2?.currentStep || 0,
          bot2_invested: s2?.totalInvested?.toFixed(2) || '0.00',
          bot2_pnl: s2?.totalPnL?.toFixed(2) || '0.00',
          bot2_result: s2?.status === 'won' ? 'WIN' : s2?.status === 'lost' ? 'LOSS' : s2?.status || '-',
          bot3_id: s3?._id?.substring(0, 12) || '-',
          bot3_status: s3?.status || '-',
          bot3_steps: s3?.currentStep || 0,
          bot3_invested: s3?.totalInvested?.toFixed(2) || '0.00',
          bot3_pnl: s3?.totalPnL?.toFixed(2) || '0.00',
          bot3_result: s3?.status === 'won' ? 'WIN' : s3?.status === 'lost' ? 'LOSS' : s3?.status || '-',
        };
        
        table.push(row);
      }
    });
    
    // Выводим таблицу
    console.log('Рынок'.padEnd(42), 'Asset', 'Signal', 'Bot2 ID'.padEnd(15), 'Bot2 Status'.padEnd(13), 'Bot2 Steps'.padEnd(12), 'Bot2 $'.padEnd(11), 'Bot2 P&L'.padEnd(11), 'Bot2 Result'.padEnd(13), 'Bot3 ID'.padEnd(15), 'Bot3 Status'.padEnd(13), 'Bot3 Steps'.padEnd(12), 'Bot3 $'.padEnd(11), 'Bot3 P&L'.padEnd(11), 'Bot3 Result');
    console.log('-'.repeat(150));
    
    table.forEach(row => {
      console.log(
        row.market.padEnd(42),
        row.asset.padEnd(5),
        row.signalColor.padEnd(6),
        row.bot2_id.padEnd(15),
        row.bot2_status.padEnd(13),
        String(row.bot2_steps).padEnd(12),
        row.bot2_invested.padEnd(11),
        row.bot2_pnl.padEnd(11),
        row.bot2_result.padEnd(13),
        row.bot3_id.padEnd(15),
        row.bot3_status.padEnd(13),
        String(row.bot3_steps).padEnd(12),
        row.bot3_invested.padEnd(11),
        row.bot3_pnl.padEnd(11),
        row.bot3_result
      );
    });
    
    // Статистика
    console.log();
    console.log('='.repeat(100));
    console.log('СТАТИСТИКА СРАВНЕНИЯ BOT2 И BOT3:');
    console.log('='.repeat(100));
    
    const bot2Total = table.reduce((sum, r) => sum + parseFloat(r.bot2_invested), 0);
    const bot3Total = table.reduce((sum, r) => sum + parseFloat(r.bot3_invested), 0);
    const bot2Pnl = table.reduce((sum, r) => sum + parseFloat(r.bot2_pnl), 0);
    const bot3Pnl = table.reduce((sum, r) => sum + parseFloat(r.bot3_pnl), 0);
    
    const bot2Wins = table.filter(r => r.bot2_result === 'WIN').length;
    const bot3Wins = table.filter(r => r.bot3_result === 'WIN').length;
    const bot2Losses = table.filter(r => r.bot2_result === 'LOSS').length;
    const bot3Losses = table.filter(r => r.bot3_result === 'LOSS').length;
    const bot2Cancelled = table.filter(r => r.bot2_result === 'cancelled').length;
    const bot3Cancelled = table.filter(r => r.bot3_result === 'cancelled').length;
    
    // Процентная доходность
    const bot2ROI = bot2Total > 0 ? (bot2Pnl / bot2Total) * 100 : 0;
    const bot3ROI = bot3Total > 0 ? (bot3Pnl / bot3Total) * 100 : 0;
    
    console.log();
    console.log('BOT2:');
    console.log(`  Сделок: ${table.length}`);
    console.log(`  Инвестировано: $${bot2Total.toFixed(2)}`);
    console.log(`  P&L: $${bot2Pnl.toFixed(2)} (${bot2ROI >= 0 ? '+' : ''}${bot2ROI.toFixed(2)}%)`);
    console.log(`  Побед: ${bot2Wins}, Поражений: ${bot2Losses}, Отменено: ${bot2Cancelled}`);
    if (bot2Wins + bot2Losses > 0) {
      console.log(`  Win Rate: ${(bot2Wins / (bot2Wins + bot2Losses) * 100).toFixed(2)}%`);
    }
    console.log();
    console.log('BOT3:');
    console.log(`  Сделок: ${table.length}`);
    console.log(`  Инвестировано: $${bot3Total.toFixed(2)}`);
    console.log(`  P&L: $${bot3Pnl.toFixed(2)} (${bot3ROI >= 0 ? '+' : ''}${bot3ROI.toFixed(2)}%)`);
    console.log(`  Побед: ${bot3Wins}, Поражений: ${bot3Losses}, Отменено: ${bot3Cancelled}`);
    if (bot3Wins + bot3Losses > 0) {
      console.log(`  Win Rate: ${(bot3Wins / (bot3Wins + bot3Losses) * 100).toFixed(2)}%`);
    }
    console.log();
    console.log('='.repeat(100));
    console.log('СРАВНЕНИЕ:');
    console.log('='.repeat(100));
    console.log(`Больше наторговал: ${bot2Total > bot3Total ? 'Bot2' : 'Bot3'} ($${Math.abs(bot2Total - bot3Total).toFixed(2)})`);
    console.log(`Лучший P&L (абсолютный): ${bot2Pnl > bot3Pnl ? 'Bot2' : 'Bot3'} ($${Math.abs(bot2Pnl - bot3Pnl).toFixed(2)})`);
    console.log(`Лучший ROI (процентный): ${bot2ROI > bot3ROI ? 'Bot2' : 'Bot3'} (${Math.max(bot2ROI, bot3ROI).toFixed(2)}% vs ${Math.min(bot2ROI, bot3ROI).toFixed(2)}%)`);
    if (bot2Wins + bot2Losses > 0 && bot3Wins + bot3Losses > 0) {
      const bot2WinRate = (bot2Wins / (bot2Wins + bot2Losses)) * 100;
      const bot3WinRate = (bot3Wins / (bot3Wins + bot3Losses)) * 100;
      console.log(`Лучший Win Rate: ${bot2WinRate > bot3WinRate ? 'Bot2' : 'Bot3'} (${Math.max(bot2WinRate, bot3WinRate).toFixed(2)}% vs ${Math.min(bot2WinRate, bot3WinRate).toFixed(2)}%)`);
    }
  }
}
