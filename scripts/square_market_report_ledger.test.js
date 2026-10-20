const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DateTime } = require('luxon');
const {
  escapeHtml,
  fetchMarketActivity,
  formatActivityEntry,
  formatMarketBoundary,
  getPreviousWeekendRange,
} = require('./square_market_report_ledger');

const weekend = {
  startDate: '2026-10-17',
  endDate: '2026-10-18',
  categories: {
    fmSupplies: { totalCents: 1200, entries: [{ date: '2026-10-17', market: 'PSU', username: 'rep', description: 'Eggs', tradedFor: 'Flowers', amountCents: 1200 }] },
    fmRepTrades: { totalCents: 2000, entries: [{ date: '2026-10-18', market: null, username: 'rep', description: 'Farm food', tradedFor: null, amountCents: 2000 }] },
    fmTillCashSupplies: { totalCents: 500, entries: [{ date: '2026-10-18', market: 'King', username: 'rep', description: 'Parking', tradedFor: null, amountCents: 500 }] },
  },
};

test('uses Pacific market dates, including the daylight saving transition', () => {
  assert.equal(formatMarketBoundary('2026-10-17'), '2026-10-17T07:00:00.000Z');
  assert.equal(formatMarketBoundary('2026-10-18', true), '2026-10-19T06:59:59.999Z');
  assert.equal(formatMarketBoundary('2026-11-01', true), '2026-11-02T07:59:59.999Z');
  assert.deepEqual(getPreviousWeekendRange(DateTime.fromISO('2026-10-20T12:00:00', { zone: 'America/Los_Angeles' })),
    { start: '2026-10-17', end: '2026-10-18' });
  assert.deepEqual(getPreviousWeekendRange(DateTime.fromISO('2026-10-18T12:00:00', { zone: 'America/Los_Angeles' })),
    { start: '2026-10-10', end: '2026-10-11' });
});

test('fetches all three reconciled categories with a bearer key', async () => {
  let request;
  const result = await fetchMarketActivity('2026-10-17', '2026-10-18', {
    token: 'report-secret',
    httpClient: { get: async (url, config) => { request = { url, config }; return { data: weekend }; } },
  });
  assert.equal(result, weekend);
  assert.equal(new URL(request.url).searchParams.get('startDate'), '2026-10-17');
  assert.equal(new URL(request.url).searchParams.get('endDate'), '2026-10-18');
  assert.equal(request.config.headers.Authorization, 'Bearer report-secret');
  assert.equal(request.config.timeout, 10000);
});

test('rejects missing credentials, mismatched totals, and API failures', async () => {
  await assert.rejects(fetchMarketActivity('2026-10-17', '2026-10-18', { token: '' }), /CREDITS_REPORT_API_TOKEN/);
  await assert.rejects(fetchMarketActivity('2026-10-17', '2026-10-18', {
    token: 'secret',
    httpClient: { get: async () => ({ data: { ...weekend, categories: { ...weekend.categories, fmSupplies: { ...weekend.categories.fmSupplies, totalCents: 999 } } } }) },
  }), /total does not match/);
  await assert.rejects(fetchMarketActivity('2026-10-17', '2026-10-18', {
    token: 'secret',
    httpClient: { get: async () => { throw new Error('Ledger unavailable'); } },
  }), /Ledger unavailable/);
});

test('keeps entry text on one line and escapes notes in the email HTML', () => {
  assert.match(formatActivityEntry({ ...weekend.categories.fmSupplies.entries[0], description: 'Eggs\nnew line' }), /Eggs new line \| for Flowers/);
  assert.equal(escapeHtml('<script>"&'), '&lt;script&gt;&quot;&amp;');
});

test('full report subtracts till cash and does not email when the ledger fails', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'square-market-ledger-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'preload.cjs');
  const sent = path.join(directory, 'sent.txt');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const original = Module._load;
    const weekend = ${JSON.stringify(weekend)};
    Module._load = function(request, parent, isMain) {
      if (request === 'axios') return {
        get: async url => {
          if (url.includes('/api/reports/market-activity')) {
            if (process.env.FAIL_LEDGER) throw new Error('Ledger unavailable');
            return { data: weekend };
          }
          if (url.includes('/v2/catalog/list')) return { data: { objects: [] } };
          if (url.includes('/v2/locations')) return { data: { locations: [{ id: 'loc1', name: 'PSU', status: 'ACTIVE' }] } };
          throw new Error('Unexpected GET ' + url);
        },
        post: async url => {
          if (url.includes('/v2/orders/search')) return { data: { orders: [{
            total_money: { amount: 15000 },
            tenders: [{ type: 'CASH', amount_money: { amount: 10000 } }, { type: 'CARD', amount_money: { amount: 5000 } }],
          }] } };
          throw new Error('Unexpected POST ' + url);
        },
      };
      if (request === '../src/utils/utilities.pricing') return {
        db: { query: async () => [[]] },
        sendEmail: async () => fs.writeFileSync(process.env.REPORT_SENT_PATH, 'sent'),
      };
      return original.call(this, request, parent, isMain);
    };
  `);
  const script = path.join(__dirname, 'square_market_report.js');
  const run = (args, failLedger) => spawnSync(process.execPath, ['--require', preload, script, '2026-10-17', '2026-10-18', ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'square-market-ledger-test', CREDITS_REPORT_API_TOKEN: 'report-secret',
      SQUARE_ACCESS_TOKEN: 'square-secret', REPORT_SENT_PATH: sent, FAIL_LEDGER: failLedger ? '1' : '' },
  });

  const success = run(['--dry-run'], false);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /FM Supplies paid w\/ till cash\s+-\$5\.00/);
  assert.match(success.stdout, /Cash & Tokens\s+\$95\.00/);
  assert.match(success.stdout, /TRADES:[\s\S]*FM Supplies\s+\$12\.00[\s\S]*FM Rep Fees Per Diems & Trades\s+\$20\.00/);
  assert.equal(fs.existsSync(sent), false);

  const failure = run([], true);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /Ledger unavailable/);
  assert.equal(fs.existsSync(sent), false);
});
