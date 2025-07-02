const path = require('path');
const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });
console.log(`✅ Loaded environment: ${env} from ${envPath}`);
const Product = require('../src/models/Product');  // ✅ Capitalized class import
const utilities = require('../src/utils/utilities.pricing');
const { access } = require('fs');

const tokenManager = require("../src/utils/tokenManager");


(async () => {
	try {
		// TODO: obtain modification date in pricelist table and just select those that have been modified
		const sql = "SELECT * FROM pricelist where available_on_ll is true and dateModified > '2025-05-30'"
		const [rows] = await utilities.db.query(sql);
		const accessToken = await tokenManager.getValidAccessToken();

		console.log(`🔎 Retrieved ${rows.length} product IDs from database.`);
		for (const row of rows) {
			try {
        const product = await Product.create(row.id);
				await product.updatePricelists(accessToken);
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
