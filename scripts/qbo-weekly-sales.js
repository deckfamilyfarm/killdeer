#!/usr/bin/env node
/**
 * QBO Weekly Sales (Accrual) — Profit & Loss → Total Income by week
 *
 * Usage examples:
 *   node qbo-weekly-sales.js --start 2025-01-01 --end 2025-08-24
 *   node qbo-weekly-sales.js --weeks 12            # last 12 ISO weeks
 *
 * Outputs:
 *   - Console table of WeekStart, WeekEnd, TotalIncome
 *   - CSV at ./weekly_sales_<start>_<end>.csv
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dayjs = require('dayjs');
const isoWeek = require('dayjs/plugin/isoWeek');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });
console.log(`✅ Loaded environment: ${env} from ${envPath}`);

dayjs.extend(isoWeek);
dayjs.extend(utc);
dayjs.extend(tz);

// ---- Config ----
const {
  CLIENT_ID,
  CLIENT_SECRET,
  REALM_ID,
  REFRESH_TOKEN,
  QBO_ENV = 'production'
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !REALM_ID || !REFRESH_TOKEN) {
  console.error('Missing required env vars: CLIENT_ID, CLIENT_SECRET, REALM_ID, REFRESH_TOKEN');
  process.exit(1);
}

const TOKEN_STORE = path.join(__dirname, 'token.json');
const OAUTH_BASE = 'https://oauth.platform.intuit.com';
const API_BASE =
  QBO_ENV === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';

// Minor versions add fields/features over base; safe to omit if you prefer.
const MINOR_VERSION = 70;

// ---- Simple CLI args ----
const args = process.argv.slice(2);
const getArg = (k, def = null) => {
  const idx = args.findIndex(a => a === `--${k}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return def;
};
const startArg = getArg('start', null);
const endArg = getArg('end', null);
const weeksBack = parseInt(getArg('weeks', '0'), 10);

// Default window: last 12 full ISO weeks if nothing supplied
let startDate, endDate;
if (startArg && endArg) {
  startDate = dayjs(startArg);
  endDate = dayjs(endArg);
} else if (weeksBack > 0) {
  endDate = dayjs().endOf('isoWeek');
  startDate = endDate.subtract(weeksBack - 1, 'week').startOf('isoWeek');
} else {
  endDate = dayjs().endOf('isoWeek');
  startDate = endDate.subtract(11, 'week').startOf('isoWeek'); // 12 weeks
}

// ---- OAuth: refresh access token (and rotate refresh token) ----
async function refreshAccessToken() {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const payload = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: loadRefreshToken()
  });

  const { data } = await axios.post(
    `${OAUTH_BASE}/oauth2/v1/tokens/bearer`,
    payload.toString(),
    {
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 30000
    }
  );

  // Persist rotated tokens (Intuit rotates refresh_token on each refresh!)
  persistTokens(data);
  return data.access_token;
}

function loadRefreshToken() {
  try {
    const disk = JSON.parse(fs.readFileSync(TOKEN_STORE, 'utf-8'));
    if (disk.refresh_token) return disk.refresh_token;
  } catch (_) {}
  // fallback to .env initial token
  return REFRESH_TOKEN;
}

function persistTokens(t) {
  const toSave = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || loadRefreshToken(),
    expires_in: t.expires_in,
    x_refresh_token_expires_in: t.x_refresh_token_expires_in,
    saved_at: new Date().toISOString()
  };
  fs.writeFileSync(TOKEN_STORE, JSON.stringify(toSave, null, 2));
}

// ---- Reports API call: Profit & Loss ----
async function fetchPnL({ accessToken, start, end, summarizeBy = 'Weeks', basis = 'Accrual' }) {
  const url = new URL(
    `${API_BASE}/v3/company/${REALM_ID}/reports/ProfitAndLoss`
  );
  url.searchParams.set('start_date', start.format('YYYY-MM-DD'));
  url.searchParams.set('end_date', end.format('YYYY-MM-DD'));
  url.searchParams.set('accounting_method', basis);        // Accrual
  url.searchParams.set('summarize_column_by', summarizeBy); // Weeks (preferred)
  url.searchParams.set('minorversion', MINOR_VERSION);

  const { data } = await axios.get(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    },
    timeout: 60000
  });
  return data;
}

// ---- Parse P&L JSON → grab Income summary per column ----
function extractWeeklyIncome(reportJson) {
  if (!reportJson || !reportJson.Rows || !Array.isArray(reportJson.Rows.Row)) {
    throw new Error('Unexpected report shape');
  }

  const columns = (reportJson.Columns && reportJson.Columns.Column) || [];
  // Column 0 is "Account" label; columns[1..] are weeks
  const colLabels = columns.map(c => (c.ColTitle || '').trim());

  // Find the "Income" section
  const incomeSection = findSection(reportJson.Rows.Row, 'Income');
  if (!incomeSection || !incomeSection.Summary || !incomeSection.Summary.ColData) {
    throw new Error('Income section not found in report');
  }

  // Summary.ColData: first col is the label (e.g., "Total Income"), rest are numbers per column
  const colData = incomeSection.Summary.ColData.map(c => (c.value || '').trim());
  const out = [];

  for (let i = 1; i < colData.length; i++) {
    const label = colLabels[i] || `Col${i}`;
    const amt = Number(colData[i].replace(/[,]/g, '')) || 0;
    // Try to parse label like "Aug 04-10, 2025" → date range; fallback to ISO week inference
    const parsed = parseWeekLabel(label);
    out.push({
      label,
      weekStart: parsed?.start || null,
      weekEnd: parsed?.end || null,
      totalIncome: amt
    });
  }
  return out;
}

function findSection(rows, groupName) {
  for (const row of rows) {
    if (row.type === 'Section') {
      if (row.group === groupName) return row;
      if (row.Rows && Array.isArray(row.Rows.Row)) {
        const nested = findSection(row.Rows.Row, groupName);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function parseWeekLabel(lbl) {
  // Common QBO week label format is like "Aug 04-10, 2025"
  const m = lbl.match(/^([A-Za-z]{3,})\s+(\d{1,2})-(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const [ , monStr, d1, d2, year ] = m;
  const s = dayjs(`${monStr} ${d1}, ${year}`);
  const e = dayjs(`${monStr} ${d2}, ${year}`).endOf('day');
  if (!s.isValid() || !e.isValid()) return null;
  return { start: s.format('YYYY-MM-DD'), end: e.format('YYYY-MM-DD') };
}

// ---- Fallback: if Weeks not supported, fetch Days and bucket into ISO weeks ----
function bucketDailyToWeeks(reportJson, start, end) {
  const columns = (reportJson.Columns && reportJson.Columns.Column) || [];
  const colLabels = columns.map(c => (c.ColTitle || '').trim());
  const incomeSection = findSection(reportJson.Rows.Row, 'Income');
  if (!incomeSection || !incomeSection.Summary) throw new Error('Income section missing');

  const values = incomeSection.Summary.ColData.map(c => (c.value || '').trim());
  // values[0] is label; values[1..] correspond to colLabels[1..] which should be individual days
  const buckets = new Map(); // key: ISO week string, value: { sum, minDate, maxDate }
  for (let i = 1; i < values.length; i++) {
    const lbl = colLabels[i];
    const amt = Number(values[i].replace(/[,]/g, '')) || 0;
    const d = dayjs(lbl); // Day label like "2025-08-04" or "Aug 04, 2025" varies by locale; dayjs can parse many
    if (!d.isValid()) continue;
    const wkStart = d.startOf('isoWeek').format('YYYY-MM-DD');
    const wkEnd = d.endOf('isoWeek').format('YYYY-MM-DD');
    const key = wkStart;
    const cur = buckets.get(key) || { sum: 0, start: wkStart, end: wkEnd };
    cur.sum += amt;
    buckets.set(key, cur);
  }
  // Produce ordered array between start and end
  const out = [];
  let cursor = start.startOf('isoWeek');
  while (cursor.isBefore(end.endOf('isoWeek')) || cursor.isSame(end.endOf('isoWeek'))) {
    const wkStart = cursor.format('YYYY-MM-DD');
    const b = buckets.get(wkStart) || { sum: 0, start: wkStart, end: cursor.endOf('isoWeek').format('YYYY-MM-DD') };
    out.push({ label: `ISO Week of ${wkStart}`, weekStart: b.start, weekEnd: b.end, totalIncome: b.sum });
    cursor = cursor.add(1, 'week');
  }
  return out;
}

// ---- CSV writer ----
function toCSV(rows) {
  const header = 'WeekStart,WeekEnd,TotalIncome\n';
  const lines = rows.map(r => `${r.weekStart || ''},${r.weekEnd || ''},${r.totalIncome.toFixed(2)}`).join('\n');
  return header + lines + '\n';
}

// ---- Main ----
(async () => {
  try {
    const access = await refreshAccessToken();

    let report;
    try {
      report = await fetchPnL({
        accessToken: access,
        start: startDate,
        end: endDate,
        summarizeBy: 'Weeks',
        basis: 'Accrual'
      });
    } catch (e) {
      // Fallback to Days then bucket
      const reportDaily = await fetchPnL({
        accessToken: access,
        start: startDate,
        end: endDate,
        summarizeBy: 'Days',
        basis: 'Accrual'
      });
      const weekly = bucketDailyToWeeks(reportDaily, startDate, endDate);
      printAndSave(weekly, startDate, endDate);
      return;
    }

    const weekly = extractWeeklyIncome(report);
    printAndSave(weekly, startDate, endDate);
  } catch (err) {
    console.error('Error:', err.response?.data || err.message || err);
    process.exit(1);
  }
})();

function printAndSave(rows, start, end) {
  // Console table
  console.log('\nWeekly Sales (Accrual) — Total Income');
  console.table(
    rows.map(r => ({
      WeekStart: r.weekStart,
      WeekEnd: r.weekEnd,
      TotalIncome: Number(r.totalIncome.toFixed(2))
    }))
  );
  // CSV file
  const fname = `weekly_sales_${start.format('YYYY-MM-DD')}_${end.format('YYYY-MM-DD')}.csv`;
  fs.writeFileSync(path.join(__dirname, fname), toCSV(rows));
  console.log(`Saved CSV → ${fname}\n`);
}

