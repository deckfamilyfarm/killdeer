const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildColumnMap, buildRecord } = require('./market_feedback_report');
const { prepareMarketDeposits, reconcileLocationDeposits, shortLocationName, formatLocationSales, formatCashTokenReconciliation, formatReconciliationNotes } = require('./square_market_report_deposits');

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
  assert.deepEqual(reconcileLocationDeposits(summary, entries),
    { actualCash: 7500, actualTokens: 2000, overShort: -200 });
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
    { actualCash: 0, actualTokens: null, overShort: null });
});

test('uses identical fixed-width location labels with short reps in both tables', () => {
  assert.equal(shortLocationName('Twelve chars'), 'Twelve chars');
  assert.equal(shortLocationName('Thirteenchars'), 'Thirteenc...');
  const name = 'Long Market Location';
  const entries = deposits([
    ['10/24/2026', '10/24/2026 15:00:00', name, 'Alice', '$70', '$20'],
    ['10/25/2026', '10/25/2026 15:00:00', name, 'alice', '$10', '$0'],
    ['10/25/2026', '10/25/2026 16:00:00', name, 'Stephanie', '$10', '$0'],
    ['10/24/2026', '10/24/2026 15:00:00', 'Other Market', 'Unrelated', '$90', '$0'],
  ]);
  const summaries = { [name]: { ...summary, locationName: name, locationTotal: 15000, card_refunds: 0, net_deposit: 5000 } };
  const text = formatLocationSales(summaries, entries);
  const reconciliation = formatCashTokenReconciliation(summaries, entries);
  const label = 'Long Mark... (Alice, Stephani)';
  for (const [table, columnCount] of [[text, 4], [reconciliation, 8]]) {
    const lines = table.split('\n');
    const separator = lines.findIndex(line => line.trimStart().startsWith('---'));
    const row = lines[separator + 1];
    assert.equal(row.slice(2, 2 + label.length), label);
    assert.ok(row.includes('$'), 'location and amounts share one line');
    assert.doesNotMatch(lines[separator + 2], /^\s+\(/);
    for (const line of lines.slice(2, separator + 2)) {
      assert.equal(Array.from(line).length, 2 + label.length + (columnCount - 1) * 10);
      for (let column = 1; column < columnCount; column++) {
        const start = 2 + label.length + (column - 1) * 10;
        assert.equal(line.slice(start, start + 2), '  ');
        if (line === row && line.slice(start + 2, start + 10).trim()) {
          assert.notEqual(line[start + 2], ' ', 'values start at the same left edge as headings');
        }
      }
    }
  }
  assert.doesNotMatch(text, /YN Actual|Over\/Short|Unrelated|Stephanie/);
  assert.match(formatLocationSales(summaries, []), /\(Missing\)/);
});

test('reconciliation shows signed rep differences and leaves farm counts and variance blank', () => {
  const entries = deposits([['10/24/2026', '10/24/2026 15:00:00', "St. John's", 'Rep', '$80', '$20']]);
  const table = formatCashTokenReconciliation({ 'St. John’s': summary }, entries).split('\n');
  assert.equal(table[2].trim(), 'Square');
  assert.deepEqual(table[3].trim().split(/\s{2,}/), ['Cash/', 'Rep', 'Farm', 'Farm', 'Over/']);
  assert.deepEqual(table[4].trim().split(/\s{2,}/),
    ['Location', 'Tokens', 'Rep Cash', 'Tokens', 'Diff', 'Cash', 'Tokens', 'short']);
  // The final three columns contain spaces only, with no invented farm totals.
  assert.deepEqual(table[6].trim().split(/\s{2,}/), ["St. John’s (Rep)", '$97.00', '$80.00', '$20.00', '+$3.00']);
  assert.match(table[6], /\+\$3\.00\s+$/);
  const missing = formatCashTokenReconciliation({ 'St. John’s': summary }, []).split('\n');
  assert.deepEqual(missing[6].trim().split(/\s{2,}/), ["St. John’s (Missing)", '$97.00', 'MISSING', 'MISSING', 'N/A']);
});


test('calculates Diff from displayed amounts even when Square also has an unmatched sales date', () => {
  const entries = deposits([['11/1/2026', '11/1/2026 14:48:32', 'Montavilla', 'Stephanie', '$54', '$171']]);
  const montavilla = { ...summary, locationName: 'Montavilla', marketDates: new Set(['2026-10-31', '2026-11-01']), cash: 83108, cash_refunds: 0 };
  assert.deepEqual(reconcileLocationDeposits(montavilla, entries),
    { actualCash: 5400, actualTokens: 17100, overShort: -60608 });
  const text = formatCashTokenReconciliation({ Montavilla: montavilla }, entries);
  assert.match(text, /Montavilla \(Stephani\)\s+\$831\.08\s+\$54\.00\s+\$171\.00\s+-\$606\.08/);
  assert.doesNotMatch(text, /incomplete cash\/token submissions/);
  const notes = formatReconciliationNotes({ Montavilla: montavilla }, entries);
  assert.match(notes, /incomplete cash\/token submissions for 2026-10-31/);
  assert.match(notes, /Yellow Notes market dates: 2026-11-01/);
});
