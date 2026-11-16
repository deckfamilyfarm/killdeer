const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { loadReportOrders, resolveMarketAssignments, lateFeedbackNotes, paymentTime } = require('./square_market_report_locations');
const { buildRows } = require('./square_market_report_sheet');

function record(name, time, amounts = [1000], device = 'ipad1') {
  return { location: { id: name, name }, order: { id: name + time, created_at: time,
    total_money: { amount: amounts.reduce((a, b) => a + b, 0) } },
  tenders: amounts.map((amount, i) => ({ tender: { type: i ? 'CASH' : 'CARD', amount_money: { amount } },
    payment: { status: 'COMPLETED', created_at: time, location_id: name,
      device_details: { device_id: device, device_name: 'Unreliable name' } } })) };
}
const morning = '2026-11-15T10:00:00-08:00';
const noon = '2026-11-15T12:40:00-08:00';
const later = '2026-11-15T13:00:00-08:00';
const destinations = records => resolveMarketAssignments(records).assignments.map(a => a.destination.name);

test('Sunday switch moves whole split-payment order once and preserves the original records', () => {
  const records = [record('Hollywood', morning, [500, 700]), record('Montavilla', noon)];
  const before = JSON.stringify(records);
  const result = resolveMarketAssignments(records);
  assert.deepEqual(result.assignments.map(a => a.destination.name), ['Montavilla', 'Montavilla']);
  assert.equal(JSON.stringify(records), before);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0].text, /1 orders \/ 2 payments, \$12.00/);
  assert.match(result.notes[0].text, /Hollywood → Montavilla/);
});

test('Saturday switch works and late UTC Saturday payments use Pacific Saturday', () => {
  assert.deepEqual(destinations([
    record('Montavilla', '2026-11-15T02:00:00Z'), record('Hollywood', '2026-11-15T03:00:00Z'),
  ]), ['Hollywood', 'Hollywood']);
});

test('valid PSU/Hillsdale assignments are preserved despite misleading names', () => {
  const result = resolveMarketAssignments([
    record('PSU', '2026-11-14T10:00:00-08:00'), record('Hillsdale', morning),
  ]);
  assert.deepEqual(result.assignments.map(a => a.destination.name), ['PSU', 'Hillsdale']);
  assert.deepEqual(result.notes, []);
});

test('no destination, different device/day, multiple destinations, unclassified location, and switchback require review', () => {
  for (const following of [[], [record('Montavilla', noon, [100], 'other')],
    [record('Montavilla', '2026-11-22T12:40:00-08:00')],
    [record('Montavilla', noon), record('King', later)],
    [record('Farm', noon)], [record('Montavilla', noon), record('Hollywood', later)]]) {
    const result = resolveMarketAssignments([record('Hollywood', morning), ...following]);
    assert.equal(result.assignments[0].destination.name, 'Hollywood');
    assert.ok(result.notes.some(note => note.kind === 'review'));
  }
});

test('incomplete or conflicting split payment evidence prevents reassignment', () => {
  for (const change of [
    r => { delete r.tenders[0].payment.device_details; },
    r => { delete r.tenders[0].payment; r.tenders[0].error = 'Payment fetch failed'; },
    r => { r.tenders[0].payment.device_details.device_id = 'other'; },
    r => { r.tenders[0].payment.location_id = 'King'; },
    r => { r.tenders[0].payment.created_at = '2026-11-14T10:00:00-08:00'; },
  ]) {
    const wrong = record('Hollywood', morning, [100, 200]);
    change(wrong);
    assert.equal(destinations([wrong, record('Montavilla', noon)])[0], 'Hollywood');
  }
});

test('offline client time governs the switch; ambiguous or cross-date evidence is not moved', () => {
  const wrong = record('Hollywood', morning);
  Object.assign(wrong.tenders[0].payment, { created_at: later, is_offline_payment: true,
    offline_payment_details: { client_created_at: morning } });
  assert.equal(destinations([wrong, record('Montavilla', noon)])[0], 'Montavilla');
  delete wrong.tenders[0].payment.offline_payment_details;
  assert.equal(destinations([wrong, record('Montavilla', noon)])[0], 'Hollywood');
  assert.equal(paymentTime({ created_at: '2026-11-15T10:00:00' }), null);
  assert.equal(paymentTime({ created_at: 'bad' }), null);
});

test('incomplete evidence in the same device session blocks otherwise plausible correction', () => {
  const ambiguous = record('Montavilla', later, [100, 200]);
  delete ambiguous.tenders[1].payment;
  assert.equal(destinations([record('Hollywood', morning), record('Montavilla', noon), ambiguous])[0], 'Hollywood');
});

test('payment lookups are cached, duplicate orders skipped, and failed lookups recorded', async () => {
  let calls = 0;
  const orders = [{ id: 'one', tenders: [{ type: 'CASH', id: 'cash' }, { type: 'CARD', payment_id: 'failed' }] }];
  const records = await loadReportOrders([{ id: 'a' }, { id: 'b' }], async () => orders, async id => {
    calls++;
    if (id === 'failed') throw new Error('Unavailable');
    return { id };
  });
  assert.equal(records.length, 1);
  assert.equal(calls, 2);
  assert.equal(records[0].tenders[0].payment.id, 'cash');
  assert.match(records[0].tenders[1].error, /could not be fetched/);
});

test('late Yellow Notes and correction explanations reach both affected spreadsheet rows', () => {
  const notes = [...resolveMarketAssignments([record('Hollywood', morning), record('Montavilla', noon)]).notes,
    ...lateFeedbackNotes([{ market: 'Montavilla', marketDateIso: '2026-11-15',
      timestamp: DateTime.fromISO('2026-11-16T08:37:32-08:00') }])];
  assert.match(notes[1].text, /2026-11-16 08:37:32 PST/);
  const rows = buildRows([{ name: 'Hollywood' }, { name: 'Montavilla' }], {}, [], notes);
  assert.match(rows[1].values[9].userEnteredValue.stringValue, /AUTO-CORRECTED/);
  assert.match(rows[2].values[9].userEnteredValue.stringValue, /AUTO-CORRECTED[\s\S]*LATE YELLOW NOTES/);
});
