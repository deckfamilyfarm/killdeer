const fs = require('fs');
const path = require('path');
const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });
console.log(`✅ Loaded environment: ${env} from ${envPath}`);

const fastcsv = require('fast-csv');
const axios = require('axios');
const utilities = require('../src/utils/utilities.pricing.js');
require('dotenv').config();

async function getOrders(start, end) {
  try {
    const accessToken = await utilities.getAccessToken(process.env.LL_USERNAME, process.env.LL_PASSWORD);

    const url = `https://localline.ca/api/backoffice/v2/orders/export/?` +
      `file_type=orders_list_view&send_to_email=false&direct=true&` +
      `fulfillment_date_start=${start}&fulfillment_date_end=${end}&` +
      `payment__status=PAID&price_lists=2966%2C2718%2C3124&status=OPEN`;

    const data = await utilities.getRequestID(url, accessToken);
    const id = JSON.parse(data).id;
    const results_url = await utilities.pollStatus(id, accessToken);
    const filePath = await utilities.downloadData(results_url, `localline_orders_${end}.csv`);

    const fields = [
      'Order', 'Date', 'Customer', 'Company', 'Email', 'Phone', 'Price List', 'Vendor',
      'Product ID', 'Internal Product ID', 'Category', 'Product', 'Item Unit', 'Package Name',
      '# of Items', 'Quantity', 'Product Subtotal', 'Product Sales Tax', 'Order Discount',
      'Store Credit Applied', 'Fulfillment Fee', 'Fulfillment Tax', 'Order Total',
      'Fulfillment Date', 'Fulfillment Type', 'Fulfillment Name', 'Fulfillment Status',
      'Fulfillment Address', 'Payment Status', 'Payment Method', 'Order Status', 'Tags',
      'About This Customer', 'Customer Note', 'Back Office Note', 'Order Placed Time',
      'Fulfillment - Pickup Start Time', 'Fulfillment - Pickup End Time', 'First Name',
      'Last Name', 'Order Note', 'Fulfillment Street Address', 'Fulfillment City',
      'Fulfillment State', 'Fulfillment ZIP Code', 'Fulfillment Country', 'Payment Fee',
      'Payment Fee Amount', 'Payment Fee Tax', 'Coupon Discount', 'Package ID'
    ];

    const fieldNames = fields.map(f =>
      f === 'Order' ? 'order_id' :
      f === '# of Items' ? 'num_of_items' :
      f === 'Fulfillment - Pickup Start Time' ? 'fulfillment_pickup_start_time' :
      f === 'Fulfillment - Pickup End Time' ? 'fulfillment_pickup_end_time' :
      f.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
    );

    const deleteSql = `DELETE FROM localline_orders WHERE week_start = ? AND week_end = ?`;
    await utilities.db.query(deleteSql, [start, end]);

    const rows = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(fastcsv.parse({ headers: true }))
        .on('data', row => rows.push(row))
        .on('end', resolve)
        .on('error', reject);
    });

    const columns = ['week_start', 'week_end', ...fieldNames];
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    const sql = `INSERT INTO localline_orders (${columns.map(col => `\`${col}\``).join(', ')}) VALUES `;

    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const values = [];
      chunk.forEach(row => {
        const rowValues = fields.map(field => {
          const val = row[field]?.trim() || null;
          return val === null || val.toLowerCase() === 'null' ? null : val;
        });
        values.push([start, end, ...rowValues]);
      });

      const flatValues = values.flat();
      const batchPlaceholders = new Array(values.length).fill(placeholders).join(', ');

      try {
        //await utilities.db.query(sql + batchPlaceholders, flatValues);
        console.log(sql)
      } catch (err) {
        console.error(`❌ Failed to insert batch ${i / batchSize + 1}:`, err.message);
        await utilities.sendErrorEmail(err);
      }
    }

    console.log(`✅ Inserted ${rows.length} records into localline_orders.`);
    process.exit(0);

  } catch (error) {
    console.error('❌ Error during summarization:', error);
    utilities.sendErrorEmail(error);
    process.exit(1);
  }
}

const commandLineArgs = process.argv.slice(2);
const dateArg = commandLineArgs.length > 0 ? commandLineArgs[0] : utilities.getToday();
const priorWeek = utilities.getPreviousWeek(dateArg);
console.log(priorWeek.start + " to " +priorWeek.end)
getOrders(priorWeek.start, priorWeek.end);
