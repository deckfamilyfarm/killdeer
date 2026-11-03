# killdeer

The Killdeer symbolizes resilience, adaptability, and steady growth — traits we believe are essential for successful farm management. Like the bird, this system is built to thrive across changing landscapes while staying deeply connected to the land.

This repository maintains code for managing localline and square connections, member subscriptions, as well as inventory management.

Be sure you have `.env.production` files installed

```
npm install
npm start
```

Testing:
```
http://localhost:3402/killdeer/v2/get-product-data
```

Now running digital ocean droplet ffcsa-server

## Square Market Report and Credit Ledger

`scripts/square_market_report.js` includes product trades, employee trade-credit
use, and till-cash expenses from the Farmers Market Credit Ledger. Set these in
Killdeer's `.env.production` (or the matching `.env.<NODE_ENV>`):

- `CREDITS_REPORT_API_TOKEN`: the same long random secret configured as
  `MARKET_REPORT_API_TOKEN` on `credits.deckfamilyfarm.com`.
- `CREDITS_REPORT_API_URL`: optional; defaults to
  `https://credits.deckfamilyfarm.com/api/reports/market-activity`.

The report fails without sending email if the token is missing or the ledger
feed cannot be fetched or reconciled. Run
`node scripts/square_market_report.js YYYY-MM-DD YYYY-MM-DD --dry-run` to inspect
a completed weekend before enabling the scheduled email. Both Square and ledger
dates use the Pacific calendar day. Till-cash expenses reduce expected cash;
product trades and trade credits used appear under TRADES.

LOCATION SALES and CASH & TOKEN RECONCILIATION use identical location labels.
Market names fit within 12 characters including `...` when truncated. Booth rep
names from Yellow Notes are limited to 8 characters each and shown in parentheses
beside the market on one unwrapped line. Both tables use the same location-column
width, sized to fit the longest label. Other columns are 10 characters wide, with
long headings wrapped onto multiple lines and all headings bottom-aligned just
above the column underlines.
CASH & TOKEN RECONCILIATION lists Square Cash/Tokens (net of cash refunds),
Rep Cash, Rep Tokens, and Diff = Rep Cash + Rep Tokens - Square Cash/Tokens.
Farm Cash, Farm Tokens, and Over/short are blank for farm counts to be entered;
Over/short = Farm Cash + Farm Tokens - Square Cash/Tokens. These comparisons
use Square cash/token sales directly, without deducting till-cash expenses.
Till-cash expenses still reduce the EXPECTED DEPOSITS total above.

Rep names and deposits come from the Yellow Notes sheet using the same
`MARKET_FEEDBACK_*` / Google Sheets credentials as `scripts/market_feedback_report.js`.
Markets match regardless of case, spacing, or punctuation; repeated submissions
are consolidated per market/date. Submitted amounts remain visible even when
another Square sales date has no submission. Amounts with no submitted value
show `MISSING`. Diff always compares the displayed amounts when both rep values
are available; missing dates are flagged separately. Sheet-fetch failures stop
report delivery. Trade category totals appear as subtotals after their entries.

`AVAILABLE TRADE CREDIT` lists positive employee balances as of the report's
closing date, including credits and adjustments from earlier dates. It uses the
ledger feed's `creditBalances` field, not today's account balances. Deploy the
matching credit-ledger feed update before running this version of the report;
missing, incorrectly dated, or unreconciled balances stop email delivery.

Report failures email `jdeck88@gmail.com` with the report dates and error. This
includes report-delivery errors; if the mail service itself is unavailable, the
notification failure is logged to `scripts/output.log`. Dry runs never send email.
