/** فحص قراءة فقط لورقة مراجعة العمليات بعد إنشائها. */
const { google } = require('googleapis');
const config = require('./config');
const serviceAccount = require('./service-account.json');

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheetsApi = google.sheets({ version: 'v4', auth });
  const sheetName = config.sheets.sheetNames.operationReviews;
  const response = await sheetsApi.spreadsheets.get({
    spreadsheetId: config.sheets.spreadsheetId,
    ranges: [`'${sheetName}'!A1:L5`],
    includeGridData: true,
  });
  const sheet = (response.data.sheets || []).find(item => item.properties?.title === sheetName);
  if (!sheet) throw new Error('لم يتم العثور على ورقة مراجعة العمليات');

  const rowData = sheet.data?.[0]?.rowData || [];
  const headers = (rowData[0]?.values || []).map(cell => cell.formattedValue || '');
  const waitingRows = rowData.slice(1).filter(row => (row.values || []).some(cell => cell.formattedValue === 'بانتظار القرار')).length;
  const validationCells = rowData.flatMap((row, rowIndex) => (row.values || []).flatMap((cell, columnIndex) => (
    cell.dataValidation ? [{
      row: rowIndex + 1,
      column: columnIndex + 1,
      rule: cell.dataValidation.condition?.type || '',
      choices: cell.dataValidation.condition?.values?.map(value => value.userEnteredValue) || [],
    }] : []
  )));
  const choices = validationCells[0]?.choices || [];

  const result = {
    sheet: sheetName,
    headersValid: headers.join('|') === [
      'رقم المراجعة', 'وقت الإنشاء', 'الجروب', 'نوع التنبيه', 'المعرف المرجعي',
      'سبب المراجعة', 'القرار (1=إضافة | 2=لا يضاف)', 'حالة القرار', 'وقت القرار', 'ملاحظات النظام',
      'رقم المنتج', 'رقم الكابتن',
    ].join('|'),
    choices,
    waitingRows,
    validationCells,
  };
  console.log(JSON.stringify(result));
  if (!result.headersValid || choices.join('|') !== '1|2') process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({ success: false, error: error.message }));
  process.exitCode = 1;
});
