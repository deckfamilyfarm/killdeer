const { DateTime } = require('luxon');
const { marketKey } = require('./square_market_report_deposits');

const ZONE = 'America/Los_Angeles';
const MARKET_DAYS = { psu: 6, stjohns: 6, hollywood: 6, lcfm: 6,
  montavilla: 7, king: 7, hillsdale: 7, springfield: 7 };
const money = cents => '$' + (cents / 100).toFixed(2);
const inline = value => String(value || '').replace(/\s+/g, ' ').trim();

function paymentDevice(payment) {
  const device = payment?.device_details || payment?.card_details?.device_details;
  // device_id can be an installation ID with this prefix. Normalize both forms.
  return (device?.device_id || device?.device_installation_id || '').replace(/^DEVICE_INSTALLATION_ID:/, '');
}

function paymentTime(payment) {
  const value = payment?.is_offline_payment
    ? payment.offline_payment_details?.client_created_at : payment?.created_at;
  // Do not interpret an unzoned timestamp using the machine's local timezone.
  if (!value || !/(Z|[+-]\d\d:\d\d)$/i.test(value)) return null;
  const time = DateTime.fromISO(value, { zone: ZONE });
  return time.isValid ? time : null;
}

async function loadReportOrders(locations, fetchOrders, fetchPayment) {
  const records = [];
  const payments = new Map();
  const seenOrders = new Set();
  const getPayment = id => {
    if (!payments.has(id)) payments.set(id, Promise.resolve().then(() => fetchPayment(id))
      .then(payment => {
        if (!payment) throw new Error('Payment missing from response');
        return { payment };
      }).catch(() => ({ error: `Payment ${id} could not be fetched; fees/refunds may be incomplete` })));
    return payments.get(id);
  };
  for (const location of locations) {
    const orders = await fetchOrders(location.id);
    for (const order of orders) {
      if (order.id && seenOrders.has(order.id)) continue;
      if (order.id) seenOrders.add(order.id);
      const tenders = [];
      for (const tender of order.tenders || []) {
        const id = tender.payment_id || (['CARD', 'CASH'].includes(tender.type) ? tender.id : null);
        tenders.push({ tender, ...(id ? await getPayment(id) : {}) });
      }
      records.push({ order, location, tenders });
    }
  }
  return records;
}

function resolveMarketAssignments(records) {
  const groups = new Map();
  const assignments = records.map(record => {
    const time = DateTime.fromISO(record.order.created_at, { zone: ZONE });
    if (!time.isValid) throw new Error(`Invalid order date for ${record.location.name}`);
    const date = time.toISODate();
    const expected = MARKET_DAYS[marketKey(record.location.name)];
    // Square emits separate return-only orders without tenders or sale totals.
    // Refund amounts are already counted from the original payments. The date
    // of a return is not evidence of a market's operating day.
    const returnTotal = record.order.return_amounts?.total_money?.amount;
    const returnOnly = !record.tenders.length && !record.order.total_money &&
      record.order.returns?.length > 0 && record.order.returns.every(item => item.source_order_id) &&
      returnTotal > 0 && record.order.net_amounts?.total_money?.amount === -returnTotal;
    const entry = { ...record, destination: record.location, date, wrongDay: !returnOnly && !!expected && expected !== time.weekday,
      reasons: [], events: [] };
    for (const { tender, payment, error } of record.tenders) {
      if (error) entry.reasons.push(error);
      const taken = paymentTime(payment);
      const device = paymentDevice(payment);
      const valid = payment?.status === 'COMPLETED' && taken && device &&
        (!payment.location_id || payment.location_id === record.location.id);
      if (!valid) {
        entry.reasons.push('Incomplete payment/device evidence');
      } else {
        entry.events.push({ device, time: taken.toMillis(), date: taken.toISODate(), entry });
        if (taken.toISODate() !== date) entry.reasons.push('Payment sale date differs from order date; review offline/delayed activity');
      }
      if (!['CASH', 'CARD'].includes(tender.type)) entry.reasons.push('Unsupported tender for automatic assignment');
    }
    // A completed zero-dollar order can legitimately have no tender.
    if (!record.tenders.length && record.order.total_money?.amount !== 0 && !returnOnly) entry.reasons.push('No payment evidence');
    if (new Set(entry.events.map(event => event.device)).size > 1) entry.reasons.push('Order payments use different devices');
    return entry;
  });
  for (const entry of assignments) {
    for (const event of entry.events) {
      const key = JSON.stringify([event.device, event.date]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
  }
  for (const events of groups.values()) {
    events.sort((a, b) => a.time - b.time);
    // Require a complete, unambiguous sequence: wrong-day prefix, then one valid market.
    if (events.some(event => event.entry.reasons.length)) continue;
    const valid = events.filter(event => !event.entry.wrongDay);
    const destinations = new Set(valid.map(event => event.entry.location.id));
    if (destinations.size !== 1 || !valid.length) continue;
    const destination = valid[0].entry.location;
    const weekday = DateTime.fromISO(valid[0].date, { zone: ZONE }).weekday;
    if (MARKET_DAYS[marketKey(destination.name)] !== weekday) continue;
    const wrong = events.filter(event => event.entry.wrongDay);
    if (!wrong.length || wrong.some(event => event.time >= valid[0].time)) continue;
    for (const { entry } of wrong) entry.destination = destination;
  }

  const corrections = new Map();
  const warnings = new Map();
  for (const entry of assignments) {
    const moved = entry.destination.id !== entry.location.id;
    if (moved) {
      const device = entry.events[0].device;
      const key = JSON.stringify([entry.date, entry.location.id, entry.destination.id, device]);
      if (!corrections.has(key)) corrections.set(key, { date: entry.date, source: entry.location.name,
        destination: entry.destination.name, device, orders: 0, payments: 0, cents: 0 });
      const correction = corrections.get(key);
      correction.orders++;
      correction.payments += entry.tenders.length;
      correction.cents += entry.order.total_money?.amount || 0;
    } else if (entry.wrongDay || entry.reasons.length) {
      const reasons = [...new Set(entry.reasons)];
      if (entry.wrongDay) reasons.unshift('Wrong weekday; no unambiguous later market on the same device');
      // Aggregate without losing the payment identifiers needed to investigate fetch failures.
      const reason = reasons.join('; ');
      const key = JSON.stringify([entry.date, entry.location.id, reason]);
      if (!warnings.has(key)) warnings.set(key, { date: entry.date, location: entry.location.name,
        reason, orders: 0, cents: 0 });
      const warning = warnings.get(key);
      warning.orders++;
      warning.cents += entry.order.total_money?.amount || 0;
    }
  }
  const notes = [
    ...[...corrections.values()].map(c => ({ locations: [c.source, c.destination], kind: 'correction',
      text: `AUTO-CORRECTED ${c.date}: ${inline(c.source)} → ${inline(c.destination)}; ${c.orders} orders / ${c.payments} payments, ${money(c.cents)}; device ${c.device}. Wrong-weekday session followed by one valid market on the same device. Square records unchanged.` })),
    ...[...warnings.values()].map(w => ({ locations: [w.location], kind: 'review',
      text: `NEEDS REVIEW ${w.date}: ${inline(w.location)}; ${w.orders} orders, ${money(w.cents)}. ${w.reason}. Original assignment retained.` })),
  ];
  return { assignments, notes };
}

function lateFeedbackNotes(records) {
  return records.filter(record => record.timestamp?.isValid && record.timestamp.setZone(ZONE).toISODate() > record.marketDateIso)
    .map(record => ({ locations: [record.market], kind: 'late',
      text: `LATE YELLOW NOTES: ${inline(record.market)}, market ${record.marketDateIso}; submitted ${record.timestamp.setZone(ZONE).toFormat('yyyy-MM-dd HH:mm:ss ZZZZ')}. Included by market date.` }));
}

function formatAssignmentNotes(notes) {
  if (!notes.length) return '';
  return '\nLOCATION & SUBMISSION CHECKS:\n' + notes.map(note => `  • ${note.text}\n`).join('');
}

module.exports = { MARKET_DAYS, loadReportOrders, resolveMarketAssignments, lateFeedbackNotes, formatAssignmentNotes, paymentTime };
