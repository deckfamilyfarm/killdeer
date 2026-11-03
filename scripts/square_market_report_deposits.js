const { consolidateRecords, dedupeRecords } = require('./market_feedback_report');

const COLUMN_WIDTH = 8;
const LOCATION_NAME_WIDTH = 12;

function marketKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function prepareMarketDeposits(records) {
  // Normalize before consolidation so punctuation variants remain one market/day.
  const normalized = records.map(record => ({ ...record, market: marketKey(record.market) }));
  return consolidateRecords(dedupeRecords(normalized).uniqueRecords);
}

function reconcileLocationDeposits(summary, deposits) {
  const key = marketKey(summary.locationName);
  const entries = deposits.filter(entry => entry.market === key);
  // Preserve submitted amounts even when another Square sales date has no form.
  const cashEntries = entries.filter(entry => entry.cashCents !== null);
  const tokenEntries = entries.filter(entry => entry.tokensCents !== null);
  const actualCash = cashEntries.length ? cashEntries.reduce((sum, entry) => sum + entry.cashCents, 0) : null;
  const actualTokens = tokenEntries.length ? tokenEntries.reduce((sum, entry) => sum + entry.tokensCents, 0) : null;
  const expected = summary.cash - summary.cash_refunds;
  const overShort = actualCash === null || actualTokens === null
    ? null : actualCash + actualTokens - expected;
  return { actualCash, actualTokens, overShort };
}

function shortLocationName(name) {
  const characters = Array.from(String(name).trim());
  return characters.length > LOCATION_NAME_WIDTH ? characters.slice(0, LOCATION_NAME_WIDTH - 3).join('').trimEnd() + '...' : characters.join('');
}

function locationReps(name, deposits) {
  const workers = deposits.filter(entry => entry.market === marketKey(name))
    .flatMap(entry => entry.workers || []);
  const names = new Map();
  for (const worker of workers) {
    const label = String(worker).replace(/\s+/g, ' ').trim();
    if (label && !names.has(label.toLowerCase())) names.set(label.toLowerCase(), label);
  }
  return names.size ? [...names.values()].map(name => Array.from(name).slice(0, 8).join('')) : ['Missing'];
}

const money = cents => cents === null ? 'MISSING' : `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
const variance = cents => cents === null ? 'N/A' : `${cents > 0 ? '+' : ''}${money(cents)}`;

function locationLabel(name, deposits) {
  return `${shortLocationName(name)} (${locationReps(name, deposits).join(', ')})`;
}

function wrapCell(cell) {
  return String(cell).split('\n').flatMap(paragraph => {
    const lines = [];
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let remaining = Array.from(word);
      if (line && Array.from(line).length + 1 + remaining.length <= COLUMN_WIDTH) {
        line += ' ' + word;
        continue;
      }
      if (line) lines.push(line);
      while (remaining.length > COLUMN_WIDTH) {
        lines.push(remaining.slice(0, COLUMN_WIDTH).join(''));
        remaining = remaining.slice(COLUMN_WIDTH);
      }
      line = remaining.join('');
    }
    lines.push(line);
    return lines;
  });
}

function formatTable(headers, rows) {
  // Both tables use identical location labels, so their first columns align.
  const widths = headers.map((header, index) => index === 0
    ? Math.max(LOCATION_NAME_WIDTH, Array.from(header).length, ...rows.map(row => Array.from(row[0]).length))
    : COLUMN_WIDTH);
  const formatRow = (row, bottomAlign = false) => {
    const cells = row.map((cell, index) => index === 0 ? [cell] : wrapCell(cell));
    const height = Math.max(...cells.map(lines => lines.length));
    return Array.from({ length: height }, (_, lineIndex) =>
      '  ' + cells.map((lines, index) => {
        const offset = bottomAlign ? height - lines.length : 0;
        const cell = lines[lineIndex - offset] || '';
        const padding = ' '.repeat(widths[index] - Array.from(cell).length);
        return cell + padding;
      }).join('  ') + '\n'
    ).join('');
  };
  return formatRow(headers, true) + `  ${widths.map(width => '-'.repeat(width)).join('  ')}\n`
    + rows.map(row => formatRow(row)).join('');
}

function formatLocationSales(locationSummaries, marketDeposits) {
  const headers = ['Location', 'Total Sales', 'CC Sales\n-Fees/\nRefunds', 'Cash/\nToken\nSales'];
  const rows = Object.entries(locationSummaries).map(([name, s]) => [
    locationLabel(name, marketDeposits),
    money(s.locationTotal - s.cash_refunds - s.card_refunds),
    money(s.net_deposit),
    money(s.cash - s.cash_refunds),
  ]);
  return '\nLOCATION SALES:\n' + formatTable(headers, rows);
}

function formatCashTokenReconciliation(locationSummaries, marketDeposits) {
  const headers = ['Location', 'Square\nCash/\nTokens', 'Rep Cash', 'Rep\nTokens', 'Diff', 'Farm\nCash', 'Farm\nTokens', 'Over/\nshort'];
  const rows = Object.entries(locationSummaries).map(([name, s]) => {
    const actual = reconcileLocationDeposits(s, marketDeposits);
    return [
      locationLabel(name, marketDeposits),
      money(s.cash - s.cash_refunds),
      money(actual.actualCash),
      money(actual.actualTokens),
      variance(actual.overShort),
      '',
      '',
      '',
    ];
  });
  return '\nCASH & TOKEN RECONCILIATION:\n' + formatTable(headers, rows);
}

function formatReconciliationNotes(locationSummaries, marketDeposits) {
  let text = '  Rep Cash/Tokens: submitted Yellow Notes totals. MISSING = no amount submitted; N/A = Diff unavailable.\n';
  for (const [name, summary] of Object.entries(locationSummaries)) {
    const entries = marketDeposits.filter(entry => entry.market === marketKey(summary.locationName));
    const dates = new Set([...summary.marketDates, ...entries.map(entry => entry.marketDateIso)]);
    const missingDates = [...dates].filter(date => !entries.some(entry =>
      entry.marketDateIso === date && entry.cashCents !== null && entry.tokensCents !== null)).sort();
    if (missingDates.length) {
      const submittedDates = entries.map(entry => entry.marketDateIso).sort();
      text += `  ${shortLocationName(name)}: incomplete cash/token submissions for ${missingDates.join(', ')}.`;
      if (submittedDates.length) text += ` Yellow Notes market dates: ${submittedDates.join(', ')}.`;
      text += '\n';
    }
  }
  text += '  Diff = Rep Cash + Rep Tokens - Square Cash/Tokens. Positive = over; negative = short.\n';
  text += '  Farm Cash, Farm Tokens, and Over/short are blank pending farm counts.\n';
  text += '  Over/short = Farm Cash + Farm Tokens - Square Cash/Tokens.\n';
  return text;
}

module.exports = { marketKey, prepareMarketDeposits, reconcileLocationDeposits, shortLocationName, formatLocationSales, formatCashTokenReconciliation, formatReconciliationNotes };
