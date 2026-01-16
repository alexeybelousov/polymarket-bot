// Команда для mongosh для обновления статистики bot3
// Выполнить на сервере: mongosh <connection_string> --file update-bot3-stats-mongosh.js

// Обновляем initialDeposit и currentBalance для bot3
db.tradingstats.updateOne(
  { _id: "bot3" },
  { 
    $set: { 
      initialDeposit: 1000,
      currentBalance: 1000 
    } 
  },
  { upsert: true }
);

print("✅ Updated bot3 stats: initialDeposit = $1000, currentBalance = $1000");

