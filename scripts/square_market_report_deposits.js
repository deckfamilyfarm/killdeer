const { consolidateRecords, dedupeRecords } = require('./market_feedback_report');

function marketKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function prepareMarketDeposits(records) {
  // Normalize before consolidation so punctuation variants remain one market/day.
  const normalized = records.map(record => ({ ...record, market: marketKey(record.market) }));
  return consolidateRecords(dedupeRecords(normalized).uniqueRecords);
}

function reconcileLocationDeposits(summary, deposits, tillCashEntries) {
  const key = marketKey(summary.locationName);
  const entries = deposits.filter(entry => entry.market === key);
  const dates = new Set([...summary.marketDates, ...entries.map(entry => entry.marketDateIso)]);
  const cashComplete = dates.size > 0 && [...dates].every(date =>
    entries.some(entry => entry.marketDateIso === date && entry.cashCents !== null));
  const tokensComplete = dates.size > 0 && [...dates].every(date =>
    entries.some(entry => entry.marketDateIso === date && entry.tokensCents !== null));
  const actualCash = cashComplete ? entries.reduce((sum, entry) => sum + entry.cashCents, 0) : null;
  const actualTokens = tokensComplete ? entries.reduce((sum, entry) => sum + entry.tokensCents, 0) : null;
  const tillCash = tillCashEntries.filter(entry => marketKey(entry.market) === key)
    .reduce((sum, entry) => sum + entry.amountCents, 0);
  const expected = summary.cash - summary.cash_refunds - tillCash;
  // An expense without a market cannot be assigned reliably to a location.
  const hasUnassignedExpense = tillCashEntries.some(entry => !marketKey(entry.market));
  const overShort = actualCash === null || actualTokens === null || hasUnassignedExpense
    ? null : actualCash + actualTokens - expected;
  return { actualCash, actualTokens, overShort };
}

function formatLocationSales(locationSummaries, marketDeposits, tillCashEntries) {
  let summaryText = "";
  summaryText += `\nLOCATION SALES:\n`;
  const locationSalesHeaders = ['Location', 'Total Sales', 'CC Sales-Fees/Refunds', 'Cash/Token Sales', 'YN Actual Cash', 'YN Actual Tokens', 'Over/Short'];
  const money = cents => cents === null ? 'MISSING' : `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
  const locationSalesRows = Object.entries(locationSummaries).map(([name, s]) => {
    const actual = reconcileLocationDeposits(s, marketDeposits, tillCashEntries);
    return [
      name,
      money(s.locationTotal - s.cash_refunds - s.card_refunds),
      money(s.net_deposit),
      money(s.cash - s.cash_refunds),
      money(actual.actualCash),
      money(actual.actualTokens),
      actual.overShort === null ? 'N/A' : `${actual.overShort > 0 ? '+' : ''}${money(actual.overShort)}`,
    ];
  });
  const locationSalesWidths = locationSalesHeaders.map((header, index) =>
    Math.max(header.length, ...locationSalesRows.map(row => row[index].length))
  );
  const formatLocationSalesRow = row =>
    `  ${row.map((cell, index) => index === 0
      ? cell.padEnd(locationSalesWidths[index])
      : cell.padStart(locationSalesWidths[index])).join('  ')}\n`;
  summaryText += formatLocationSalesRow(locationSalesHeaders);
  summaryText += `  ${locationSalesWidths.map(width => '-'.repeat(width)).join('  ')}\n`;
  for (const row of locationSalesRows) summaryText += formatLocationSalesRow(row);
  summaryText += '  Actual deposits: Yellow Notes. MISSING = incomplete cash/token submissions for the market dates.\n';
  summaryText += '  Over/Short = YN Actual Cash + YN Actual Tokens - (Cash/Token Sales - till cash expenses). Positive = over; negative = short.\n';
  if (tillCashEntries.some(entry => !entry.market?.trim())) {
    summaryText += '  Over/Short unavailable: a till cash expense has no market assigned.\n';
  }

  return summaryText;
}

module.exports = { marketKey, prepareMarketDeposits, reconcileLocationDeposits, formatLocationSales };
