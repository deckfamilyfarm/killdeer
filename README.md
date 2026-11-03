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
width, sized to fit the longest label. Other columns are 8 characters wide and left-aligned, with
long headings wrapped onto multiple lines and all headings bottom-aligned just
above the column underlines. Reconciliation explanations and missing-date notes
appear at the very bottom of the unified report.
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


The Square report also includes the Yellow Notes markets worked,
sellouts, customer questions, booth issues, and positive feedback. Duplicate Yellow Notes deposit lists are omitted. Both use the same
weekend and fetched sheet data. CASH FARMERS MARKET EXPENSES lists till-cash ledger entries
and Yellow Notes fees/expenses under separate source labels, or `None reported.`
when neither source has entries. Yellow Notes expenses are informational and are
not deducted again from expected deposits. The standalone feedback script remains
available; scheduled jobs are unchanged while the unified report is being reviewed.

Available trade-credit names are resolved by employee ID from the Timesheets
`employees` table using Killdeer's existing database connection. Set
`CREDITS_EMPLOYEE_DB_SCHEMA` to override the default `timesheets` schema. Missing
employee names stop delivery and trigger the existing error alert. Amounts and
historical balances still come exclusively from the credit-ledger feed.

Report bullets use hanging indents in HTML and plain-text email so wrapped lines
align with the text after the bullet. The cash-expense deduction points to its
details in CASH FARMERS MARKET EXPENSES.
