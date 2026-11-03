const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DateTime } = require('luxon');
const { formatCashFarmersExpenses } = require('./square_market_report_feedback');
const { buildReportParts, buildColumnMap, buildRecord, consolidateRecords, dedupeRecords } = require('./market_feedback_report');

test('cash farmers expenses explicitly reports no entries', () => {
  assert.equal(formatCashFarmersExpenses({ entries: [], totalCents: 0 }, []),
    '\nCASH FARMERS MARKET EXPENSES:\n  None reported.\n');
});

test('expenses keep source labels and do not turn unknown amounts into zero or sum sources together', () => {
  const text = formatCashFarmersExpenses({ entries: [
    { date: '2026-11-01', market: 'Montavilla', username: 'Stephanie', description: 'Parking', amountCents: 500 },
  ], totalCents: 500 }, [{ expenses: [
    { marketDate: DateTime.fromISO('2026-11-01'), market: 'Montavilla', description: 'Parking', amountCents: 500 },
    { marketDate: DateTime.fromISO('2026-11-01'), market: 'Montavilla', description: 'Ice', amountCents: null },
  ] }]);
  assert.match(text, /Credit ledger — paid with till cash:/);
  assert.match(text, /Total ledger cash expenses: \$5\.00/);
  assert.match(text, /Yellow Notes — reported fees\/expenses:/);
  assert.match(text, /Ice  Amount not provided/);
  assert.doesNotMatch(text, /\$10\.00|\$0\.00|None reported/);
});

test('embedded feedback retains narrative and deposits while returning notes separately', () => {
  const headers = ['Market Date', 'Timestamp', "Which farmers' market did you work at?", 'Who worked at this market today?', 'Cash Deposit', 'Tokens', 'Any issues arise?', 'Any positive feedback?', 'Fees/Expenses'];
  const columns = buildColumnMap(headers);
  const record = buildRecord(['11/1/2026', '11/1/2026 15:00:00', 'Montavilla', 'Stephanie', '$54', '', 'Broken canopy', 'Great eggs', '$5 Parking'], 2, columns, 'America/Los_Angeles');
  const { uniqueRecords, duplicateCount } = dedupeRecords([record, record]);
  const parts = buildReportParts({
    entries: consolidateRecords(uniqueRecords), duplicateCount, rawRecordCount: 2,
    startArg: '2026-10-31', endArg: '2026-11-01', sheetTitle: 'Yellow Notes',
    options: { title: 'Feedback', timeZone: 'America/Los_Angeles' },
    embedded: true, includeExpenses: false,
  });
  assert.match(parts.text, /MARKETS WORKED:[\s\S]*Stephanie/);
  assert.match(parts.text, /CASH DEPOSITS & TOKENS:[\s\S]*\$54\.00/);
  assert.match(parts.text, /ISSUES \/ BOOTH PROBLEMS:[\s\S]*Broken canopy/);
  assert.match(parts.text, /POSITIVE FEEDBACK:[\s\S]*Great eggs/);
  assert.doesNotMatch(parts.text, /NOTES:|FEES & EXPENSES:|Generated on/);
  assert.deepEqual(parts.notes, ['1 duplicate submission omitted.', 'Missing tokens: Montavilla.']);
});
