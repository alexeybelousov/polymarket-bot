// Команды для полной очистки базы данных для bot3
// Выполнить на сервере: mongosh <connection_string> --file clear-bot3-db-mongosh.js

print("🧹 Начинаем очистку данных bot3...");

// 1. Удаляем все серии bot3
const seriesResult = db.tradeseries.deleteMany({ botId: "bot3" });
print(`✅ Удалено серий: ${seriesResult.deletedCount}`);

// 2. Удаляем статистику bot3
const statsResult = db.tradingstats.deleteOne({ _id: "bot3" });
print(`✅ Удалено статистик: ${statsResult.deletedCount}`);

// 3. Удаляем логи bot3 (если есть)
const logsResult = db.signallogs.deleteMany({ botId: "bot3" });
print(`✅ Удалено логов: ${logsResult.deletedCount}`);

print("✅ Очистка данных bot3 завершена!");

