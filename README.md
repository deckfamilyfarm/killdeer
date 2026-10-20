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
