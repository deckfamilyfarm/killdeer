const path = require('path');
const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });
console.log(`✅ Loaded environment: ${env} from ${envPath}`);

const IS_TESTING = true; // 👈 Set to false to enable updates

const Product = require('../src/models/Product');
const utilities = require('../src/utils/utilities.pricing');
const tokenManager = require("../src/utils/tokenManager");

(async () => {
  try {
    const sql = "SELECT * FROM pricelist WHERE id = 43";
    const [rows] = await utilities.db.query(sql);
    const accessToken = await tokenManager.getValidAccessToken();

    console.log(`🔎 Retrieved ${rows.length} product IDs from database.`);
    for (const row of rows) {
      try {
        const product = await Product.create(row.id, IS_TESTING);
        await product.updatePricelists(accessToken, IS_TESTING);
        if (IS_TESTING) {
          console.log(`[TEST MODE] Would update price lists for product ID ${row.id}`);
        } else {
          console.log(`✅ Updated price lists for product ID ${row.id}`);
        }
      } catch (err) {
        console.error(`❌ Failed to initialize product ID ${row.id}:`, err.message);
        console.log(err);
      }
    }
  } catch (err) {
    console.error("❌ Error fetching product IDs from database:", err.message);
    process.exit(1);
  }

  console.log("🎉 Script execution complete.");
  process.exit(0);
})();

