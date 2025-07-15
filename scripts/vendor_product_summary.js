// summarize_vendor_products_from_localline.js
const fs = require('fs');
const path = require('path');
const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });
console.log(`✅ Loaded environment: ${env} from ${envPath}`);

const fastcsv = require('fast-csv');
const axios = require('axios');
const utilities = require('./utilities');
require('dotenv').config();

async function summarizeVendorProducts(start, end) {
  try {
    const accessToken = JSON.parse(await utilities.getAccessToken()).access;

    const url = `https://localline.ca/api/backoffice/v2/orders/export/?` +
      `file_type=orders_list_view&send_to_email=false&direct=true&` +
      `fulfillment_date_start=${start}&fulfillment_date_end=${end}&` +
      `payment__status=PAID&price_lists=2966%2C2718%2C3124&status=OPEN`;

    const data = await utilities.getRequestID(url, accessToken);
    const id = JSON.parse(data).id;
    const results_url = await utilities.pollStatus(id, accessToken);
    const filePath = await utilities.downloadData(results_url, `vendor_product_orders_${end}.csv`);

    const vendorTotals = {};

    fs.createReadStream(filePath)
      .pipe(fastcsv.parse({ headers: true }))
      .on('data', row => {
        const vendor = row.Vendor?.trim() || 'Unknown';
        const product = row.Product?.trim() || 'Unnamed Product';
        const subtotal = parseFloat(row['Product Subtotal']) || 0;

        if (!vendorTotals[vendor]) vendorTotals[vendor] = {};
        if (!vendorTotals[vendor][product]) vendorTotals[vendor][product] = 0;

        vendorTotals[vendor][product] += subtotal;
      })
      .on('end', () => {
        // Round to 2 decimal places
        for (const vendor in vendorTotals) {
          for (const product in vendorTotals[vendor]) {
            vendorTotals[vendor][product] = parseFloat(vendorTotals[vendor][product].toFixed(2));
          }
        }

        const outFile = `vendor_product_summary_${end}.json`;
        fs.writeFileSync(outFile, JSON.stringify(vendorTotals, null, 2));
        console.log(`✅ Summary saved to ${outFile}`);
      });

  } catch (error) {
    console.error('❌ Error during summarization:', error);
    utilities.sendErrorEmail(error);
  }
}

// CLI usage
const commandLineArgs = process.argv.slice(2); // slice to remove first two default arguments
const dateArg = commandLineArgs.length > 0 ? commandLineArgs[0] : utilities.getToday();
const priorWeek = utilities.getPreviousWeek(dateArg); // Date is formatted as "YYYY-MM-DD"
summarizeVendorProducts(priorWeek.start, priorWeek.end);

