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
  formatCreditBalances,
  resolveCreditBalanceNames,
  formatActivityEntry,
  formatMarketBoundary,
  getPreviousWeekendRange,
} = require('./square_market_report_ledger');

const weekend = {
  startDate: '2026-10-17',
  endDate: '2026-10-18',
  creditBalances: { asOfDate: '2026-10-18', totalCents: 3500, entries: [
    { employeeId: 'E001', username: 'rep-a', balanceCents: 2500 },
    { employeeId: 'E002', username: '', balanceCents: 1000 },
  ] },
  categories: {
    fmSupplies: { totalCents: 1200, entries: [{ date: '2026-10-17', market: 'PSU', username: 'rep', description: 'Eggs', tradedFor: 'Flowers', amountCents: 1200 }] },
    fmRepTrades: { totalCents: 2000, entries: [{ date: '2026-10-18', market: null, username: 'rep', description: 'Farm food', tradedFor: null, amountCents: 2000 }] },
    fmTillCashSupplies: { totalCents: 500, entries: [{ date: '2026-10-18', market: 'PSU', username: 'rep', description: 'Parking', tradedFor: null, amountCents: 500 }] },
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

test('requires dated, reconciled employee balances from the ledger', async () => {
  for (const creditBalances of [
    undefined,
    { ...weekend.creditBalances, asOfDate: '2026-10-19' },
    { ...weekend.creditBalances, totalCents: 9999 },
    { ...weekend.creditBalances, entries: [weekend.creditBalances.entries[0], weekend.creditBalances.entries[0]] },
    { ...weekend.creditBalances, entries: [{ employeeId: 'E001', username: 'rep', balanceCents: -1 }] },
  ]) {
    await assert.rejects(fetchMarketActivity('2026-10-17', '2026-10-18', {
      token: 'secret', httpClient: { get: async () => ({ data: { ...weekend, creditBalances } }) },
    }), /[Cc]redit/);
  }
  const text = formatCreditBalances(weekend.creditBalances);
  assert.match(text, /As of 2026-10-18/);
  assert.match(text, /rep-a\s+\$25\.00/);
  assert.match(text, /Employee E002\s+\$10\.00/);
  assert.match(text, /Total available credit\s+\$35\.00/);
  assert.match(formatCreditBalances({ asOfDate: '2026-10-18', totalCents: 0, entries: [] }), /No available credit balances/);
});

test('full report subtracts till cash and alerts the owner when reporting fails', t => {
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
        create: () => ({
          interceptors: { request: { use() {} } },
          get: async url => {
            if (process.env.FAIL_FEEDBACK) throw new Error('Yellow Notes unavailable');
            if (url.includes('/values/')) return { data: { values: [
              ['Market Date', 'Timestamp', "Which farmers' market did you work at?", 'Who worked at this market today?', 'Cash Deposit', 'Tokens', 'Any positive feedback?'],
              ['10/18/2026', '10/18/2026 17:00:00', 'PSU', 'rep', '$70', '$22', 'Great eggs <fresh>'],
              ['10/11/2026', '10/11/2026 17:00:00', 'PSU', 'rep', '$999', '$999'],
            ] } };
            return { data: { properties: { title: 'Yellow Notes' }, sheets: [{ properties: { title: 'Form Responses 1', gridProperties: { rowCount: 3, columnCount: 6 } } }] } };
          },
        }),
        get: async url => {
          if (url.includes('/api/reports/market-activity')) {
            if (process.env.FAIL_LEDGER) throw new Error('Ledger unavailable');
            return { data: weekend };
          }
          if (url.includes('/v2/catalog/list')) return { data: { objects: [] } };
          if (url.includes('/v2/locations')) return { data: { locations: [{ id: 'loc1', name: 'PSU', status: 'ACTIVE' }] } };
          if (url.includes('/v2/payments/cash-payment')) return { data: { payment: { refunded_money: { amount: 300 } } } };
          if (url.includes('/v2/payments/card-payment')) return { data: { payment: { refunded_money: { amount: 400 }, processing_fee: [{ amount_money: { amount: 200 } }] } } };
          if (url.includes('/v2/payments/card-tender-only')) return { data: { payment: { processing_fee: [{ amount_money: { amount: 130 } }] } } };
          throw new Error('Unexpected GET ' + url);
        },
        post: async url => {
          if (url.includes('/v2/orders/search')) return { data: { orders: [{
            created_at: '2026-10-19T00:00:00Z',
            total_money: { amount: 16000 },
            tenders: [
              { type: 'CASH', amount_money: { amount: 10000 }, payment_id: 'cash-payment' },
              { type: 'CARD', amount_money: { amount: 5000 }, processing_fee_money: { amount: 200 }, payment_id: 'card-payment' },
              { type: 'CARD', amount_money: { amount: 1000 }, id: 'card-tender-only' },
            ],
          }] } };
          throw new Error('Unexpected POST ' + url);
        },
      };
      if (request === '../src/utils/utilities.pricing') return {
        db: { query: async sql => sql.includes('employees') ? [[{ id: 'E001', name: 'Able, Alice' }, { id: 'E002', name: 'Baker, Bob' }]] : [[]] },
        sendEmail: async options => {
          if (process.env.FAIL_EMAIL === 'all' ||
              (process.env.FAIL_EMAIL === 'report' && !options.subject.startsWith('FAILED:'))) {
            throw new Error('Mail service unavailable');
          }
          fs.appendFileSync(process.env.REPORT_SENT_PATH, JSON.stringify(options) + '\\n');
        },
      };
      return original.call(this, request, parent, isMain);
    };
  `);
  const script = path.join(__dirname, 'square_market_report.js');
  const run = (args, failLedger, failFeedback = false, failEmail = '') => {
    fs.rmSync(sent, { force: true });
    return spawnSync(process.execPath, ['--require', preload, script, '2026-10-17', '2026-10-18', ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'square-market-ledger-test', CREDITS_REPORT_API_TOKEN: 'report-secret',
      SQUARE_ACCESS_TOKEN: 'square-secret', REPORT_SENT_PATH: sent, FAIL_LEDGER: failLedger ? '1' : '',
      FAIL_FEEDBACK: failFeedback ? '1' : '', FAIL_EMAIL: failEmail, MARKET_FEEDBACK_GOOGLE_APPLICATION_CREDENTIALS: '', GOOGLE_APPLICATION_CREDENTIALS: '',
      MARKET_FEEDBACK_GOOGLE_SHEETS_API_KEY: 'sheet-secret' },
    });
  };
  const assertAlert = message => {
    const emails = fs.readFileSync(sent, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(emails.length, 1);
    assert.equal(emails[0].to, 'jdeck88@gmail.com');
    assert.equal(emails[0].cc, undefined);
    assert.equal(emails[0].subject, 'FAILED: Square Market & Yellow Notes Report (2026-10-17 to 2026-10-18)');
    assert.ok(emails[0].text.includes(message));
  };

  const success = run(['--dry-run'], false);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /PRODUCT SALES:/);
  assert.doesNotMatch(success.stdout, /CATEGORY SALES:/);
  const headings = [...success.stdout.matchAll(/^([A-Z][A-Z &]+):$/gm)].map(match => match[1]);
  assert.deepEqual(headings, ['PRODUCT SALES', 'DEDUCTIONS', 'EXPECTED DEPOSITS', 'LOCATION SALES', 'CASH & TOKEN RECONCILIATION', 'CASH FARMERS MARKET EXPENSES', 'TRADES', 'AVAILABLE TRADE CREDIT', 'SUMMARY STATISTICS', 'MARKETS WORKED', 'POSITIVE FEEDBACK', 'NOTES']);
  const deductions = success.stdout.split('DEDUCTIONS:\n')[1].split('\nEXPECTED DEPOSITS:')[0];
  assert.match(deductions, /^  • FM Fees & Returns\s+-\$10\.30\s+\(Fees \$3\.30, Returns \$7\.00\)\n  • FM expenses paid w\/ till cash\s+-\$5\.00\s+\(see CASH FARMERS MARKET EXPENSES below\)\n$/);
  assert.doesNotMatch(success.stdout, /FM TOKENS:|Deduct tokens from Square Cash/);
  assert.match(success.stdout, /Cash & Tokens\s+\$92\.00/);
  const locationSales = success.stdout.split('LOCATION SALES:\n')[1].split('\nCASH & TOKEN RECONCILIATION:')[0].trim().split('\n');
  assert.deepEqual(locationSales[0].trim().split(/\s{2,}/), ['CC Sales', 'Cash/']);
  assert.deepEqual(locationSales[1].trim().split(/\s{2,}/), ['Total', '-Fees/', 'Token']);
  assert.deepEqual(locationSales[2].trim().split(/\s{2,}/), ['Location', 'Sales', 'Refunds', 'Sales']);
  assert.deepEqual(locationSales[4].trim().split(/\s{2,}/), ['PSU (rep)', '$153.00', '$52.70', '$97.00']);
  assert.equal(locationSales.length, 5);
  const reconciliation = success.stdout.split('CASH & TOKEN RECONCILIATION:\n')[1].split('\nCASH FARMERS MARKET EXPENSES:')[0].trim().split('\n');
  assert.deepEqual(reconciliation[4].trim().split(/\s{2,}/), ['PSU (rep)', '$97.00', '$70.00', '$22.00', '-$5.00']);
  const trades = success.stdout.split('TRADES:\n')[1].split('\nAVAILABLE TRADE CREDIT:')[0];
  assert.match(trades, /^  • FM Supplies\n    • .*\$12\.00\n  • Subtotal FM Supplies\s+\$12\.00\n  • FM Rep Fees Per Diems & Trades\n    • .*\$20\.00\n  • Subtotal FM Rep Fees Per Diems & Trades\s+\$20\.00\n$/);
  assert.match(success.stdout, /Able, Alice/);
  assert.match(success.stdout, /Baker, Bob/);
  assert.doesNotMatch(success.stdout, /Employee E002/);
  assert.match(success.stdout, /AVAILABLE TRADE CREDIT:[\s\S]*As of 2026-10-18[\s\S]*Total available credit\s+\$35\.00/);
  assert.match(success.stdout, /CASH FARMERS MARKET EXPENSES:[\s\S]*Credit ledger — paid with till cash:[\s\S]*Parking  \$5\.00/);
  assert.match(success.stdout, /YELLOW NOTES \/ MARKET FEEDBACK:[\s\S]*MARKETS WORKED:[\s\S]*POSITIVE FEEDBACK:\n  • PSU: Great eggs <fresh>/);
  assert.doesNotMatch(success.stdout, /CASH DEPOSITS & TOKENS:|Total Cash Deposits|Total Tokens/);
  const beforeNotes = success.stdout.split('\nNOTES:\n')[0];
  assert.doesNotMatch(beforeNotes, /Rep Cash\/Tokens: submitted Yellow Notes totals/);
  assert.match(success.stdout, /NOTES:[\s\S]*Rep Cash\/Tokens: submitted Yellow Notes totals/);
  assert.match(success.stdout, /Over\/short = Farm Cash \+ Farm Tokens - Square Cash\/Tokens\./);
  assert.match(success.stdout, /Google Sheet: DRY RUN: would create a new square-auto-10\/17-10\/18/);
  assert.equal(fs.existsSync(sent), false);

  const failure = run([], true);
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /Ledger unavailable/);
  assertAlert('Ledger unavailable');

  const feedbackFailure = run([], false, true);
  assert.equal(feedbackFailure.status, 1);
  assert.match(feedbackFailure.stderr, /Yellow Notes unavailable/);
  assertAlert('Yellow Notes unavailable');

  const deliveryFailure = run([], false, false, 'report');
  assert.equal(deliveryFailure.status, 1);
  assertAlert('Mail service unavailable');

  const notificationFailure = run([], true, false, 'all');
  assert.equal(notificationFailure.status, 1);
  assert.match(notificationFailure.stderr, /Ledger unavailable/);
  assert.match(notificationFailure.stderr, /Failed to send failure notification: Mail service unavailable/);
  assert.equal(fs.existsSync(sent), false);

  const dryRunFailure = run(['--dry-run'], true);
  assert.equal(dryRunFailure.status, 1);
  assert.equal(fs.existsSync(sent), false);
});


test('credit balances resolve verified Timesheets names without changing amounts', async () => {
  let request;
  const balances = await resolveCreditBalanceNames(weekend.creditBalances, {
    query: async (sql, params) => {
      request = { sql, params };
      return [[{ id: 'E001', name: 'Able, Alice' }, { id: 'E002', name: 'Baker, Bob' }]];
    },
  });
  assert.match(request.sql, /FROM `timesheets`\.`employees` WHERE id IN \(\?,\?\)/);
  assert.deepEqual(request.params, ['E001', 'E002']);
  assert.equal(balances.totalCents, 3500);
  assert.deepEqual(balances.entries.map(entry => entry.balanceCents), [2500, 1000]);
  const text = formatCreditBalances(balances);
  assert.match(text, /Able, Alice/);
  assert.match(text, /Baker, Bob/);
  assert.doesNotMatch(text, /rep-a|Employee E002/);
  await assert.rejects(resolveCreditBalanceNames(weekend.creditBalances, { query: async () => [[]] }), /Employee name missing/);
  await assert.rejects(resolveCreditBalanceNames(weekend.creditBalances, {}, 'invalid;schema'), /Invalid credit employee database schema/);
});
