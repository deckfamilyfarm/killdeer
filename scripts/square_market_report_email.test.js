const assert = require('node:assert/strict');
const { test } = require('node:test');
const { formatReportEmail } = require('./square_market_report_email');

test('workbook and exact weekend tab links precede the report in HTML and plain text', () => {
  const links = [
    { label: 'Cash Reconciliation Report', url: 'https://docs.google.com/spreadsheets/d/example/edit' },
    { label: 'Weekend reconciliation sheet', url: 'https://docs.google.com/spreadsheets/d/example/edit#gid=123' },
  ];
  const body = formatReportEmail('REPORT CONTENT', links);
  assert.ok(body.text.startsWith('Cash Reconciliation Report: ' + links[0].url));
  assert.ok(body.text.includes(links[1].url + '\n\nREPORT CONTENT'));
  for (const link of links) {
    assert.ok(body.html.includes(`<a href="${link.url}">${link.label}</a>`));
    assert.ok(body.html.indexOf(link.url) < body.html.indexOf('REPORT CONTENT'));
  }
});

test('wrapped bullets align continuation lines after the bullet in both email formats', () => {
  for (const prefix of ['  • ', '    • ']) {
    const description = 'Montavilla: ' + 'Customer feedback about eggs and the market. '.repeat(8);
    const body = formatReportEmail(prefix + description);
    const lines = body.text.split('\n');
    assert.ok(lines.length > 1);
    assert.ok(lines.every(line => line.length <= 100));
    assert.ok(lines.slice(1).every(line => line.startsWith(' '.repeat(prefix.length))));
    assert.equal(lines.map(line => line.trim()).join(' '), (prefix + description).trim());
    assert.ok(body.html.includes(`padding-left:${prefix.length}ch;text-indent:-${prefix.length}ch`));
    assert.match(body.html, /white-space:pre-wrap/);
  }
});

test('email formatting preserves table spacing and escapes feedback markup', () => {
  const table = '  Location                Sales   \n  ----------------------  --------\n  Montavilla (Stephani)   $4093.01';
  const report = table + '\n\n  • PSU: <script>alert("x")</script> & feedback\n';
  const body = formatReportEmail(report);
  assert.equal(body.text, report);
  assert.ok(body.html.includes(table));
  assert.doesNotMatch(body.html, /<script>/);
  assert.match(body.html, /&lt;script&gt;/);
  assert.match(body.html, /&amp; feedback/);
});
