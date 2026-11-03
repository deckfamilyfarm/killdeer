const { escapeHtml } = require('./square_market_report_ledger');

function wrapBullet(line, width = 100) {
  const prefix = line.match(/^\s*•\s+/)?.[0];
  if (!prefix) return line;
  const indent = ' '.repeat(prefix.length);
  const lines = [];
  let remaining = line;
  while (remaining.length > width) {
    let split = remaining.lastIndexOf(' ', width);
    if (split <= prefix.length) split = width;
    lines.push(remaining.slice(0, split).trimEnd());
    remaining = indent + remaining.slice(split).trimStart();
  }
  lines.push(remaining);
  return lines.join('\n');
}

function formatReportEmail(report) {
  const lines = report.split('\n');
  const html = lines.map((line, index) => {
    const prefix = line.match(/^\s*•\s+/)?.[0];
    if (!prefix) return escapeHtml(line) + (index < lines.length - 1 ? '\n' : '');
    // Keep the original first-line spacing; subsequent lines start after the bullet.
    const width = Array.from(prefix).length;
    return `<span style="display:block;white-space:pre-wrap;overflow-wrap:break-word;padding-left:${width}ch;text-indent:-${width}ch">${escapeHtml(line)}</span>`;
  }).join('');
  return {
    text: lines.map(line => wrapBullet(line)).join('\n'),
    html: `<pre style="margin:0;font-family:monospace;white-space:pre">${html}</pre>`,
  };
}

module.exports = { formatReportEmail };
