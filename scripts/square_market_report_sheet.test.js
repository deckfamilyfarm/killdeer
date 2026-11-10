const test = require('node:test');
const assert = require('node:assert/strict');
const { updateReconciliationSheet, buildRows, selectLocations, nextTitle } = require('./square_market_report_sheet');
const options = { start: '2026-11-07', end: '2026-11-08',
  locations: [{ name: 'PSU' }, { name: 'No Sales' }, { name: 'Other Sales' }, { name: 'Notes Only' }],
  summaries: { PSU: { locationName: 'PSU', cash: 12345, cash_refunds: 45 }, 'Other Sales': { orderCount: 1, locationTotal: 100 } },
  deposits: [{ market: 'psu', workers: ['Alice'], cashCents: 10000, tokensCents: 2300 }, { market: 'notesonly', workers: ['Bob'], cashCents: 0, tokensCents: 0 }] };

test('required markets always appear, and optional markets require actual activity or a submission', () => {
  const names = selectLocations(options.locations, options.summaries, options.deposits).map(x => x.name);
  for (const name of ['Hillsdale', 'Hollywood', 'King', 'LCFM', 'Montavilla', 'PSU', 'Springfield', 'Woodstock', 'Other Sales', 'Notes Only']) assert.ok(names.includes(name));
  assert.ok(!names.includes('No Sales'));
});

test('source amounts, blank highlighted inputs, row formulas, and totals after three blank rows', () => {
  const rows = buildRows(options.locations, options.summaries, options.deposits);
  const values = rows[1].values.map(cell => cell.userEnteredValue);
  assert.deepEqual(values.slice(0, 5), [{ stringValue: 'PSU' }, { stringValue: 'Alice' }, { numberValue: 123 }, { numberValue: 100 }, { numberValue: 23 }]);
  assert.equal(values[5], undefined);
  assert.equal(values[6], undefined);
  assert.equal(values[7].formulaValue, '=IF(COUNT(F2:G2)=0,"",SUM(F2:G2))');
  assert.equal(values[8].formulaValue, '=IF(H2="","",H2-C2)');
  for (const row of rows.slice(-4, -1)) assert.ok(row.values.every(cell => !cell.userEnteredValue));
  assert.equal(rows.at(-1).values[0].userEnteredValue.stringValue, 'TOTAL');
  for (const [i, col] of [...'CDEFGHI'].entries()) assert.equal(rows.at(-1).values[i + 2].userEnteredValue.formulaValue, `=SUM(${col}2:${col}${rows.length - 4})`);
});

test('first unused suffix is selected without overwriting any existing title', () => {
  const sheets = ['base', 'base.1', 'base.3'].map(title => ({ properties: { title } }));
  assert.equal(nextTitle('base', sheets), 'base.2');
  assert.equal(nextTitle('new', sheets), 'new');
});

test('only new report cells are written, totals are boxed and bold, and Instructions stays first', async () => {
  for (const hasInstructions of [false, true]) {
    let writes;
    let reads = 0;
    const existing = [{ properties: { title: 'square-auto-11/7-11/8', sheetId: 42 } }, { properties: { title: 'square-auto-11/7-11/8.1', sheetId: 43 } }];
    if (hasInstructions) existing.push({ properties: { title: 'Instructions', sheetId: 44 } });
    const client = { async get() { reads++; return { data: { sheets: existing } }; }, async post(url, body) { writes = body.requests; } };
    assert.match(await updateReconciliationSheet({ ...options, client }), /^CREATED square-auto-11\/7-11\/8\.2:/);
    assert.equal(reads, 1);
    const reportId = writes[0].addSheet.properties.sheetId;
    assert.equal(writes[0].addSheet.properties.index, 0);
    for (const req of writes) {
      if (req.updateCells) assert.ok(!existing.some(sheet => sheet.properties.sheetId === req.updateCells.range.sheetId));
    }
    assert.ok(writes.some(req => req.updateBorders?.innerVertical?.style === 'SOLID'));
    assert.ok(writes.some(req => req.repeatCell?.cell.userEnteredFormat?.textFormat?.bold && req.repeatCell.range.startRowIndex > 0));
    if (hasInstructions) assert.ok(writes.some(req => req.updateSheetProperties?.properties.sheetId === 44 && req.updateSheetProperties.properties.index === 0));
    else assert.ok(writes.some(req => req.addSheet?.properties.title === 'Instructions' && req.addSheet.properties.index === 0));
    assert.ok(reportId !== 42);
  }
  assert.match(await updateReconciliationSheet({ ...options, dryRun: true, client: {} }), /^DRY RUN/);
});
