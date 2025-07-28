const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const axios = require('axios');
const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });
console.log(`✅ Loaded environment: ${env} from ${envPath}`);

const utilities = require('../src/utils/utilities.pricing.js');

async function downloadBinaryData(url, fileName, accessToken) {
	try {
		const headers = {
			'Authorization': `Bearer ${accessToken}`
		};
		const response = await axios.get(url, { responseType: 'arraybuffer', headers });
		// Write the binary data to a file
		fs.writeFileSync(fileName, response.data);

		return fileName; // Return the path to the downloaded file
	} catch (error) {
		throw new Error(error)
	}
}
async function getProducts() {
	try {
		const accessToken = await utilities.getAccessToken(
			process.env.LL_USERNAME,
			process.env.LL_PASSWORD
		);
		const products_url = 'https://localline.ca/api/backoffice/v2/products/export/?direct=true'
		products_file = 'data/products.xlsx'
		downloadBinaryData(products_url, products_file, accessToken)
			.then((products_file) => {
				console.log('done writing ' + products_file);

				// Read the XLSX file and target "Packages and Pricing" sheet
				const workbook = xlsx.readFile(products_file);
				const sheetName = 'Packages and pricing';

				if (!workbook.Sheets[sheetName]) {
					throw new Error(`Sheet "${sheetName}" not found in XLSX file.`);
				}

				const sheet = workbook.Sheets[sheetName];
				const rows = xlsx.utils.sheet_to_json(sheet);

				console.log(rows)
				const records = rows.map(r => ({
					package_id: r['Package ID'],
					product_name: r['Product'],
					package_price: r['Price']
				})).filter(r => r.package_id && r.product_name && r.package_price);

				// Optional: Save to SQL
				const deleteSql = `DELETE FROM localline_products`;
				//await utilities.db.query(deleteSql);

				const insertSql = `INSERT INTO localline_products (package_id, product_name, package_price) VALUES ?`;
				const values = records.map(r => [r.package_id, r.product_name, r.package_price]);

				if (values.length > 0) {
					//await utilities.db.query(insertSql, [values]);
					console.log(`✅ Inserted ${values.length} records into localline_products.`);
				} else {
					console.log(`⚠️ No valid rows found in "${sheetName}".`);
				}

				process.exit(1);
			});

	} catch (err) {
		console.error('❌ Error loading products:', err);
		await utilities.sendErrorEmail(err);
		process.exit(1);
	}
}

getProducts();

