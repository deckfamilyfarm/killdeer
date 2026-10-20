const path = require('path');
const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });

const axios = require('axios');
const utilities = require('../src/utils/utilities.pricing');
const {
  escapeHtml,
  fetchMarketActivity,
  formatActivityEntry,
  formatMarketBoundary,
  getPreviousWeekendRange,
} = require('./square_market_report_ledger');

const ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const BASE_LOCATIONS_URL = 'https://connect.squareup.com/v2/locations';
const BASE_ORDERS_URL = 'https://connect.squareup.com/v2/orders/search';
const BASE_CATALOG_URL = 'https://connect.squareup.com/v2/catalog/list';
const BASE_OBJECT_URL = 'https://connect.squareup.com/v2/catalog/object';
const BASE_PAYMENTS_URL = 'https://connect.squareup.com/v2/payments';

const variationToItem = {};
const itemToCategory = {};
const categoryIdToName = {};
const allCategorySales = {};
const allCategoryCOGS = {};
const gpprByCategory = {};

const { DateTime } = require('luxon');  // At top of file, if not already

function parseCliArgs(argv) {
  const positional = [];
  const options = {
    from: 'jdeck88@gmail.com',
    to: 'info@deckfamilyfarm.com',
    cc: 'jdeck88@gmail.com',
    title: 'Square Market Report',
    subject: null,
    deductionPrefix: 'FM',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const key = arg.slice(2, eqIndex === -1 ? undefined : eqIndex);
    const value = eqIndex === -1 ? argv[++i] : arg.slice(eqIndex + 1);

    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }

    if (key === 'deduction-prefix') {
      options.deductionPrefix = value;
      continue;
    }

    if (!['from', 'to', 'cc', 'title', 'subject'].includes(key)) {
      throw new Error(`Unknown option --${key}`);
    }

    options[key] = value;
  }

  const [startArg, endArg, locationIdArg] = positional;
  return { startArg, endArg, locationIdArg, options };
}

function formatLine(label, amount = null, prefix = '', note = '') {
  const labelCol = label.padEnd(40);
  const value = amount === null ? '' : typeof amount === 'string'
    ? amount
    : `${prefix}$${(amount / 100).toFixed(2)}`;
  const detail = value ? `${value.padEnd(12)}${note ? `  ${note}` : ''}` : note;
  return `  • ${labelCol}${detail}`.trimEnd() + '\n';
}

async function loadGpprFromDatabase() {
  const sql = `
    SELECT c.name AS category, c.gppr
    FROM pricelist p
    JOIN category c ON p.category_id = c.id
    WHERE c.gppr IS NOT NULL`;

  const [rows] = await utilities.db.query(sql);
  for (const row of rows) {
    gpprByCategory[row.category] = parseFloat(row.gppr);
  }
}


async function fetchFullCatalog() {
  let cursor = null;
  do {
    const res = await axios.get(`${BASE_CATALOG_URL}?types=ITEM,ITEM_VARIATION,CATEGORY${cursor ? `&cursor=${cursor}` : ''}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
    });
    const objects = res.data.objects || [];
    for (const obj of objects) {
      const { type, id } = obj;
      if (type === 'CATEGORY') {
        categoryIdToName[id] = obj.category_data?.name || 'Unnamed Category';
      }
      if (type === 'ITEM') {
        itemToCategory[id] = obj.item_data?.category_id || obj.item_data?.categories?.[0]?.id || null;
      }
      if (type === 'ITEM_VARIATION') {
        const itemId = obj.item_variation_data?.item_id;
        if (itemId) variationToItem[id] = itemId;
      }
    }
    cursor = res.data.cursor;
  } while (cursor);
}

async function fetchLocationIds() {
  const res = await axios.get(BASE_LOCATIONS_URL, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
  });

  // filter out "ON FARM SALES"
  return res.data.locations
    .filter(loc => loc.status === 'ACTIVE')
    .map(loc => ({ id: loc.id, name: loc.name }));
}

async function fetchOrders(locationId, begin, end, cursor = null, collected = []) {
  const body = {
    location_ids: [locationId],
    query: {
      filter: {
        date_time_filter: { created_at: { start_at: begin, end_at: end } },
        state_filter: { states: ['COMPLETED'] }
      }
    },
    limit: 100
  };
  if (cursor) body.cursor = cursor;

  const res = await axios.post(BASE_ORDERS_URL, body, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  collected.push(...(res.data.orders || []));
  return res.data.cursor
    ? fetchOrders(locationId, begin, end, res.data.cursor, collected)
    : collected;
}

async function resolveCategoryName(variationId) {
  if (!variationId) return 'Uncategorized';
  let itemId = variationToItem[variationId];
  if (!itemId) {
    try {
      const res = await axios.get(`${BASE_OBJECT_URL}/${variationId}`, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
      });
      itemId = res.data.object.item_variation_data?.item_id;
      variationToItem[variationId] = itemId;
    } catch {
      return 'Uncategorized';
    }
  }

  let categoryId = itemToCategory[itemId];
  if (!categoryId) {
    try {
      const res = await axios.get(`${BASE_OBJECT_URL}/${itemId}`, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
      });
      const item = res.data.object.item_data;
      categoryId = item.category_id || item.categories?.[0]?.id;
      itemToCategory[itemId] = categoryId;
    } catch {
      return 'Uncategorized';
    }
  }

  return categoryIdToName[categoryId] || 'Uncategorized';
}

// ─── Main Execution ────────────────────────────────────────────────────────────

(async () => {
  let { startArg, endArg, locationIdArg, options } = parseCliArgs(process.argv.slice(2));
  if (!startArg || !endArg) {
    ({ start: startArg, end: endArg } = getPreviousWeekendRange());
  }

  const begin = formatMarketBoundary(startArg);
  const end = formatMarketBoundary(endArg, true);
  const marketActivity = await fetchMarketActivity(startArg, endArg);

  await loadGpprFromDatabase();
  await fetchFullCatalog();
  const allLocations = await fetchLocationIds();

  const locations = locationIdArg
    ? allLocations.filter(loc => loc.id === locationIdArg)
    : allLocations;

  if (locationIdArg && locations.length === 0) {
    console.error(`❌ No matching active location for ID: ${locationIdArg}`);
    process.exit(1);
  }

  const locationSummaries = {};

  for (const loc of locations) {
    const orders = await fetchOrders(loc.id, begin, end);
    const summary = {
      locationName: loc.name,
      orderCount: 0,
      locationTotal: 0,
      discounts: 0,
      tips: 0,
      serviceCharges: 0,
      cash: 0,
      card: 0,
      fees: 0,
      card_refunds: 0,
      cash_refunds: 0,
    };

    for (const order of orders) {
      summary.orderCount++;
      summary.locationTotal += order.total_money?.amount || 0;
      summary.discounts += order.total_discount_money?.amount || 0;
      summary.tips += order.total_tip_money?.amount || 0;
      summary.serviceCharges += order.total_service_charge_money?.amount || 0;

      if (order.line_items) {
        for (const item of order.line_items) {
          const amount = item.total_money?.amount || 0;

          if (item.item_type !== 'ITEM') continue;

          const variationId = item.catalog_object_id;
          const category = await resolveCategoryName(variationId);
          allCategorySales[category] = (allCategorySales[category] || 0) + amount;

          const gppr = gpprByCategory[category] ?? 0.5;
          const cogs = amount * (1 - gppr);
          allCategoryCOGS[category] = (allCategoryCOGS[category] || 0) + cogs;
        }
      }

      if (order.tenders) {
        for (const tender of order.tenders) {
          const amt = tender.amount_money?.amount || 0;
          summary.fees += tender.processing_fee_money?.amount || 0;
          if (tender.type === 'CASH') summary.cash += amt;
          if (tender.type === 'CARD') summary.card += amt;
          if (tender.payment_id) {
            try {
              const payment = await axios.get(`${BASE_PAYMENTS_URL}/${tender.payment_id}`, {
                headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
              }).then(res => res.data.payment);
              for (const fee of payment.processing_fee || []) {
                summary.fees += fee.amount_money?.amount || 0;
              }
              if (tender.type === 'CASH') {
                summary.cash_refunds += payment.refunded_money?.amount || 0;
              }
              if (tender.type === 'CARD') {
                summary.card_refunds += payment.refunded_money?.amount || 0;
              }
            } catch (err) {
              console.warn(`⚠️ Payment fetch failed: ${tender.payment_id}`);
            }
          }
        }
      }
    }

    const net_deposit = summary.card - summary.fees - summary.card_refunds;
    if (net_deposit > 0) locationSummaries[loc.name] = { ...summary, net_deposit };
  }

  // ── Summary Output ──
  const grand = {
    orders: 0, locationTotal: 0, discounts: 0, tips: 0,
    serviceCharges: 0, cash: 0, card: 0, fees: 0,
    card_refunds: 0, cash_refunds: 0, net_deposit: 0
  };

  for (const summary of Object.values(locationSummaries)) {
    grand.orders += summary.orderCount;
    grand.locationTotal += summary.locationTotal;
    grand.discounts += summary.discounts;
    grand.tips += summary.tips;
    grand.serviceCharges += summary.serviceCharges;
    grand.cash += summary.cash - summary.cash_refunds;
    grand.card += summary.card - summary.card_refunds;
    grand.fees += summary.fees;
    grand.cash_refunds += summary.cash_refunds;
    grand.card_refunds += summary.card_refunds;
    grand.net_deposit += summary.net_deposit;
  }

  // Convert current time to Pacific Time
  const pacificTime = DateTime.now().setZone('America/Los_Angeles').toFormat('yyyy-MM-dd HH:mm');

  // Build summaryText
  let summaryText = `${options.title.toUpperCase()}: ${startArg} to ${endArg}\n`;
  summaryText += `Generated on ${pacificTime}\n`;

  summaryText += `\nPRODUCT SALES:\n`;
  let totalRevenue = 0;
  let totalCOGS = 0;

  for (const [cat, amt] of Object.entries(allCategorySales).sort(([a], [b]) => a.localeCompare(b))) {
    const cogs = allCategoryCOGS[cat] || 0;
    const gppr = gpprByCategory[cat] ?? 0.5;
    const gpprPercent = (gppr * 100).toFixed(0);
    totalRevenue += amt;
    totalCOGS += cogs;

    const note = `(COGS $${(cogs / 100).toFixed(2)}, GPPR ${gpprPercent}%)`;
    summaryText += formatLine(cat, amt, '', note);
  }
  summaryText += formatLine('Subtotal', totalRevenue);

  summaryText += `\nFM TOKENS:\n`;
  summaryText += `  Note: Deduct tokens from Square Cash because Square counts tokens and cash together.\n`;

  summaryText += `\nDEDUCTIONS:\n`;
  const returns = grand.cash_refunds + grand.card_refunds;
  const feesAndReturns = grand.fees + returns;
  const deductionBreakdown = `(Fees $${(grand.fees / 100).toFixed(2)}, Returns $${(returns / 100).toFixed(2)})`;
  summaryText += formatLine(`${options.deductionPrefix} Fees & Returns`, feesAndReturns, '-', deductionBreakdown);
  summaryText += formatLine('FM Supplies paid w/ till cash', marketActivity.categories.fmTillCashSupplies.totalCents, '-');

  summaryText += `\nEXPECTED DEPOSITS:\n`;
  summaryText += formatLine('Cards', grand.net_deposit);
  summaryText += formatLine('Cash & Tokens', grand.cash - marketActivity.categories.fmTillCashSupplies.totalCents,
    '', 'Net of till cash expenses');

  summaryText += `\nLOCATION SALES:\n`;
  const locationSalesHeaders = ['Location', 'Total Sales', 'CC Sales', 'Cash/Token Sales', '# Orders'];
  const locationSalesRows = Object.entries(locationSummaries).map(([name, s]) => [
    name,
    `$${((s.locationTotal - s.cash_refunds - s.card_refunds) / 100).toFixed(2)}`,
    `$${((s.card - s.card_refunds) / 100).toFixed(2)}`,
    `$${((s.cash - s.cash_refunds) / 100).toFixed(2)}`,
    String(s.orderCount)
  ]);
  const locationSalesWidths = locationSalesHeaders.map((header, index) =>
    Math.max(header.length, ...locationSalesRows.map(row => row[index].length))
  );
  const valueColumnWidth = Math.max(...locationSalesWidths.slice(1));
  locationSalesWidths.fill(valueColumnWidth, 1);
  const formatLocationSalesRow = row =>
    `  ${row.map((cell, index) => index === 0
      ? cell.padEnd(locationSalesWidths[index])
      : cell.padStart(locationSalesWidths[index])).join('  ')}\n`;
  summaryText += formatLocationSalesRow(locationSalesHeaders);
  summaryText += `  ${locationSalesWidths.map(width => '-'.repeat(width)).join('  ')}\n`;
  for (const row of locationSalesRows) summaryText += formatLocationSalesRow(row);

  summaryText += `\nTRADES:\n`;
  summaryText += formatLine('FM Supplies', marketActivity.categories.fmSupplies.totalCents);
  for (const entry of marketActivity.categories.fmSupplies.entries) {
    summaryText += formatActivityEntry(entry);
  }
  summaryText += formatLine('FM Rep Fees Per Diems & Trades', marketActivity.categories.fmRepTrades.totalCents);
  for (const entry of marketActivity.categories.fmRepTrades.entries) {
    summaryText += formatActivityEntry(entry);
  }

  summaryText += `\nSUMMARY STATISTICS:\n`;
  summaryText += formatLine('Weighted COGS', totalCOGS);
  summaryText += formatLine('Gross Profit', totalRevenue - totalCOGS);
  summaryText += formatLine('Discounts', grand.discounts, '-');
  summaryText += formatLine('Cash Refunds', grand.cash_refunds, '-');
  summaryText += formatLine('Card Refunds', grand.card_refunds, '-');
  summaryText += formatLine('Discounts/Refunds Total', grand.discounts + grand.cash_refunds + grand.card_refunds, '-');
  const weightedGppr = totalRevenue > 0 ? ((1 - (totalCOGS / totalRevenue)) * 100).toFixed(1) : '0.0';
  summaryText += formatLine('Weighted GPPR', `${weightedGppr}%`);

  const subject = options.subject || `${options.title}: ${startArg} to ${endArg}`;
  const emailOptions = {
    from: options.from,
    to: options.to,
    subject,
    html: `<pre>${escapeHtml(summaryText)}</pre>`
  };
  if (options.cc) emailOptions.cc = options.cc;

  if (options.dryRun) {
    console.log(`DRY RUN: would send "${subject}" to ${options.to}${options.cc ? ` cc ${options.cc}` : ''}`);
    console.log(summaryText);
    process.exit(0);
  }

  try {
    await utilities.sendEmail(emailOptions);
    console.log("📧 Email sent.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to send email:", err);
    process.exit(1);
  }

})().catch((error) => {
  console.error('Square Market Report failed:', error.message || error);
  process.exit(1);
});
