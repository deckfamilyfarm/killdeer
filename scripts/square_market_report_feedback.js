const { formatActivityEntry } = require('./square_market_report_ledger');

function formatCashFarmersExpenses(tillCash, feedbackEntries) {
  let text = '\nCASH FARMERS MARKET EXPENSES:\n';
  const reportedExpenses = feedbackEntries.flatMap(entry => entry.expenses);
  if (!tillCash.entries.length && !reportedExpenses.length) {
    return text + '  None reported.\n';
  }
  if (tillCash.entries.length) {
    text += '  Credit ledger — paid with till cash:\n';
    for (const entry of tillCash.entries) text += formatActivityEntry(entry);
    text += `  Total ledger cash expenses: $${(tillCash.totalCents / 100).toFixed(2)}\n`;
  }
  if (reportedExpenses.length) {
    text += '  Yellow Notes — reported fees/expenses:\n';
    for (const entry of reportedExpenses) {
      const amount = entry.amountCents === null ? 'Amount not provided' : `$${(entry.amountCents / 100).toFixed(2)}`;
      text += `    • ${entry.marketDate.toISODate()} | ${entry.market} | ${entry.description}  ${amount}\n`;
    }
  }
  return text;
}

module.exports = { formatCashFarmersExpenses };
