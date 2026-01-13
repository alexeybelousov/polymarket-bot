const mongoose = require('mongoose');
const TradeSeries = require('./src/models/TradeSeries');
const TradingStats = require('./src/models/TradingStats');
require('dotenv').config();

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');

    // 1. Миграция TradeSeries: добавляем botId: 'bot1' для всех серий без botId
    console.log('Migrating TradeSeries...');
    const result1 = await TradeSeries.updateMany(
      { botId: { $exists: false } },
      { $set: { botId: 'bot1' } }
    );
    console.log(`  Updated ${result1.modifiedCount} TradeSeries documents (added botId: 'bot1')\n`);

    // 2. Миграция TradingStats: создаем TradingStats с botId: 'bot1' из старого 'global'
    console.log('Migrating TradingStats...');
    const oldStats = await TradingStats.findById('global');
    
    if (oldStats) {
      // Проверяем, есть ли уже bot1
      const bot1Stats = await TradingStats.findById('bot1');
      
      if (!bot1Stats) {
        // Создаем новый документ с botId: 'bot1' на основе старого
        const newStats = await TradingStats.create({
          _id: 'bot1',
          initialDeposit: oldStats.initialDeposit,
          currentBalance: oldStats.currentBalance,
          totalTrades: oldStats.totalTrades,
          wonTrades: oldStats.wonTrades,
          lostTrades: oldStats.lostTrades,
          cancelledTrades: oldStats.cancelledTrades,
          totalPnL: oldStats.totalPnL,
          totalCommissions: oldStats.totalCommissions,
          maxWinStreak: oldStats.maxWinStreak,
          maxLossStreak: oldStats.maxLossStreak,
          currentStreak: oldStats.currentStreak,
          winsByStep: oldStats.winsByStep,
          updatedAt: oldStats.updatedAt,
        });
        console.log(`  Created TradingStats with botId: 'bot1' from old 'global'`);
        console.log(`  Old balance: $${oldStats.currentBalance}, New balance: $${newStats.currentBalance}`);
      } else {
        console.log(`  TradingStats with botId: 'bot1' already exists, skipping`);
      }
      
      // Удаляем старый документ 'global' (опционально, можно закомментировать для безопасности)
      // await TradingStats.findByIdAndDelete('global');
      // console.log(`  Deleted old TradingStats with _id: 'global'`);
    } else {
      // Если нет старого 'global', создаем новый bot1 с дефолтами
      const newStats = await TradingStats.create({ _id: 'bot1' });
      console.log(`  Created new TradingStats with botId: 'bot1' (default values)`);
    }

    console.log('\n✅ Migration completed successfully!');
    console.log('\nSummary:');
    console.log(`  - TradeSeries: ${result1.modifiedCount} documents updated`);
    console.log(`  - TradingStats: migrated from 'global' to 'bot1'`);
    
    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Migration error:', error);
    process.exit(1);
  }
}

migrate();

