const axios = require('axios');
const { DateTime } = require('luxon');

const MARKET_ZONE = 'America/Los_Angeles';
const DEFAULT_REPORT_URL = 'https://credits.deckfamilyfarm.com/api/reports/market-activity';
const CATEGORY_KEYS = ['fmSupplies', 'fmRepTrades', 'fmTillCashSupplies'];

function marketDate(date) {
  const parsed = DateTime.fromISO(date, { zone: MARKET_ZONE });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parsed.isValid || parsed.toISODate() !== date) {
    throw new Error('Invalid market report date: ' + date);
  }
  return parsed;
}

function formatMarketBoundary(date, isEnd = false) {
  const day = marketDate(date);
  return (isEnd ? day.endOf('day') : day.startOf('day')).toUTC().toISO();
}

function getPreviousWeekendRange(now = DateTime.now()) {
  const today = now.setZone(MARKET_ZONE).startOf('day');
  const daysSinceCompletedSunday = today.weekday === 7 ? 7 : today.weekday;
  const sunday = today.minus({ days: daysSinceCompletedSunday });
  return {
    start: sunday.minus({ days: 1 }).toISODate(),
    end: sunday.toISODate(),
  };
}

function assertCategory(category, name, startDate, endDate) {
  if (!category || !Number.isSafeInteger(category.totalCents) || category.totalCents < 0 || !Array.isArray(category.entries)) {
    throw new Error('Invalid credit ledger category: ' + name);
  }
  let sum = 0;
  for (const entry of category.entries) {
    if (!entry || !Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0 ||
        typeof entry.date !== 'string' || entry.date < startDate || entry.date > endDate ||
        typeof entry.description !== 'string') {
      throw new Error('Invalid credit ledger entry in ' + name);
    }
    sum += entry.amountCents;
  }
  if (sum !== category.totalCents) throw new Error('Credit ledger total does not match entries in ' + name);
}

async function fetchMarketActivity(startDate, endDate, options = {}) {
  marketDate(startDate);
  marketDate(endDate);
  if (endDate < startDate) throw new Error('Market report end date is before start date');
  const token = options.token === undefined ? process.env.CREDITS_REPORT_API_TOKEN : options.token;
  const reportUrl = options.url || process.env.CREDITS_REPORT_API_URL || DEFAULT_REPORT_URL;
  const httpClient = options.httpClient || axios;
  if (!token) throw new Error('CREDITS_REPORT_API_TOKEN is required for the Square Market Report');
  const url = new URL(reportUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Credit ledger report URL must use HTTPS');
  }
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  const response = await httpClient.get(url.toString(), {
    headers: { Authorization: 'Bearer ' + token },
    timeout: 10000,
  });
  const activity = response.data;
  if (!activity || activity.startDate !== startDate || activity.endDate !== endDate || !activity.categories) {
    throw new Error('Credit ledger returned an unexpected report date range');
  }
  for (const name of CATEGORY_KEYS) assertCategory(activity.categories[name], name, startDate, endDate);
  return activity;
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatActivityEntry(entry) {
  const parts = [entry.date];
  if (entry.market) parts.push(oneLine(entry.market));
  if (entry.username) parts.push(oneLine(entry.username));
  parts.push(oneLine(entry.description));
  if (entry.tradedFor) parts.push('for ' + oneLine(entry.tradedFor));
  return '    • ' + parts.join(' | ') + '  $' + (entry.amountCents / 100).toFixed(2) + '\n';
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

module.exports = {
  escapeHtml,
  fetchMarketActivity,
  formatActivityEntry,
  formatMarketBoundary,
  getPreviousWeekendRange,
};
