/**
 * مهمة مستقلة لمزامنة الأسماء التي أُدخلت يدوياً في أوراق اليوم.
 * تُشغّل من Railway Cron مرة كل ساعة، ولا تبدأ اتصال WhatsApp ولا تعدّل أرصدة أو حركات.
 */
const sheets = require('./sheets');

async function main() {
  try {
    await sheets.initialize();
    const result = await sheets.syncManualNamesFromTodaySheets();
    console.log(`MANUAL_NAME_SYNC_RESULT ${JSON.stringify(result)}`);
    if (!result.success) process.exitCode = 1;
  } catch (error) {
    console.error(`MANUAL_NAME_SYNC_FAILED ${error.message}`);
    process.exitCode = 1;
  }
}

main();
