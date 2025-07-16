// summarize_vendor_products_from_localline.js
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

async function getProducts(start, end) {
  try {
    const accessToken = await utilities.getAccessToken(process.env.LL_USERNAME, process.env.LL_PASSWORD);

    const url = `https://localline.ca/api/backoffice/v2/orders/export/?` +
      `file_type=orders_list_view&send_to_email=false&direct=true&` +
      `fulfillment_date_start=${start}&fulfillment_date_end=${end}&` +
      `payment__status=PAID&price_lists=2966%2C2718%2C3124&status=OPEN`;

    const data = await utilities.getRequestID(url, accessToken);
    const id = JSON.parse(data).id;
    const results_url = await utilities.pollStatus(id, accessToken);
    const filePath = await utilities.downloadData(results_url, `vendor_product_orders_${end}.csv`);

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

    //const fieldNames = fields.map(f => f.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase());
const fieldNames = fields.map(f =>
  f === 'Order' ? 'order_id' :
  f === '# of Items' ? 'num_of_items' :
  f === 'Fulfillment - Pickup Start Time' ? 'fulfillment_pickup_start_time' :
  f === 'Fulfillment - Pickup End Time' ? 'fulfillment_pickup_end_time' :
  f.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase()
);


    // Clear old records for the selected week
    const deleteSql = `DELETE FROM vendor_product_details WHERE week_start = ? AND week_end = ?`;
    await utilities.db.query(deleteSql, [start, end])

    // Load all rows from CSV into memory
    const rows = [];
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(fastcsv.parse({ headers: true }))
        .on('data', row => rows.push(row))
        .on('end', resolve)
        .on('error', reject);
    });

    // Insert rows one-by-one
    for (const row of rows) {
      const values = fields.map(field => {
        const val = row[field]?.trim() || null;
        return val === null || val.toLowerCase() === 'null' ? null : val;
      });
      const columns = ['week_start', 'week_end', ...fieldNames];
      const placeholders = columns.map(() => '?').join(', ');
      //const sql = `INSERT INTO vendor_product_details (${columns.join(', ')}) VALUES (${placeholders})`;
	  const sql = `INSERT INTO vendor_product_details (${columns.map(col => `\`${col}\``).join(', ')}) VALUES (${placeholders})`;

      const params = [start, end, ...values];

   	  await utilities.db.query(sql, params)
      //await new Promise((resolveInsert, rejectInsert) => {
       // utilities.db.query(sql, params, (err, results) => {
        //  if (err) rejectInsert(err);
         // else resolveInsert(results);
        //});
      //});
    }

    console.log(`✅ Inserted ${rows.length} records into vendor_product_details.`);
    process.exit(0);

  } catch (error) {
    console.error('❌ Error during summarization:', error);
    utilities.sendErrorEmail(error);
    process.exit(1);
  }
}

// CLI usage
const commandLineArgs = process.argv.slice(2);
const dateArg = commandLineArgs.length > 0 ? commandLineArgs[0] : utilities.getToday();
const priorWeek = utilities.getPreviousWeek(dateArg);
getProducts(priorWeek.start, priorWeek.end);
