const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildColumnMap, buildRecord } = require('./market_feedback_report');
const { prepareMarketDeposits, reconcileLocationDeposits } = require('./square_market_report_deposits');

const headers = ['Market Date', 'Timestamp', "Which farmers' market did you work at?", 'Who worked at this market today?', 'Cash Deposit', 'Tokens'];
const columns = buildColumnMap(headers);
const deposits = rows => prepareMarketDeposits(rows.map((row, i) => buildRecord(row, i + 2, columns, 'America/Los_Angeles')));
const summary = { locationName: 'St. John’s', marketDates: new Set(['2026-10-24']), cash: 10000, cash_refunds: 300 };

test('matches punctuation variants and uses the latest deposits without adding duplicate submissions', () => {
  const entries = deposits([
    ['10/24/2026', '10/24/2026 15:00:00', "St. John's", 'Rep', '$70', '$20'],
    ['10/24/2026', '10/24/2026 16:00:00', 'ST JOHNS', 'Rep', '$75', ''],
    ['10/24/2026', '10/24/2026 16:00:00', 'ST JOHNS', 'Rep', '$75', ''],
  ]);
  assert.equal(entries.length, 1);
  assert.deepEqual(reconcileLocationDeposits(summary, entries, [
    { market: 'St. Johns', amountCents: 500 },
    { market: 'Hollywood', amountCents: 1000 },
  ]), { actualCash: 7500, actualTokens: 2000, overShort: 300 });
  assert.equal(reconcileLocationDeposits(summary, entries, []).overShort, -200);
});

test('adds both days at one market and preserves explicit zero amounts', () => {
  const entries = deposits([
    ['10/24/2026', '10/24/2026 15:00:00', 'LCFM', 'Rep', '$100.25', '$50.50'],
    ['10/25/2026', '10/25/2026 15:00:00', 'LCFM', 'Rep', '$0', '$0'],
  ]);
  assert.deepEqual(reconcileLocationDeposits({ ...summary, locationName: 'LCFM', marketDates: new Set(['2026-10-24', '2026-10-25']), cash: 15075, cash_refunds: 0 }, entries, []),
    { actualCash: 10025, actualTokens: 5050, overShort: 0 });
});

test('missing submissions or amounts never appear as zero or a false shortage', () => {
  assert.deepEqual(reconcileLocationDeposits(summary, [], []), { actualCash: null, actualTokens: null, overShort: null });
  const entries = deposits([['10/24/2026', '10/24/2026 15:00:00', "St. John's", 'Rep', '$0', '']]);
  assert.deepEqual(reconcileLocationDeposits(summary, entries, []), { actualCash: 0, actualTokens: null, overShort: null });
  assert.deepEqual(reconcileLocationDeposits({ ...summary, marketDates: new Set(['2026-10-24', '2026-10-25']) }, entries, []),
    { actualCash: null, actualTokens: null, overShort: null });
});

test('cannot calculate a location variance when a till cash expense has no market', () => {
  const entries = deposits([['10/24/2026', '10/24/2026 15:00:00', "St. John's", 'Rep', '$70', '$20']]);
  assert.deepEqual(reconcileLocationDeposits(summary, entries, [{ market: null, amountCents: 500 }]),
    { actualCash: 7000, actualTokens: 2000, overShort: null });
});
