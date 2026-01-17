const path = require('path');
const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });
console.log(`✅ Loaded environment: ${env} from ${envPath}`);

const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const ExcelJS = require('exceljs');
const utilities = require('../src/utils/utilities.pricing');
const Product = require('../src/models/Product');

const projectRoot = path.resolve(__dirname, '..');

function base64UrlEncode(input) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
	return buffer
		.toString('base64')
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
}

function columnIndexToLetter(index) {
	let column = '';
	let remainder = index;
	while (remainder > 0) {
		const letterIndex = (remainder - 1) % 26;
		column = String.fromCharCode(65 + letterIndex) + column;
		remainder = Math.floor((remainder - 1) / 26);
	}
	return column;
}

function resolveFromProjectRoot(filePath) {
	if (!filePath) return filePath;
	return path.isAbsolute(filePath)
		? filePath
		: path.resolve(projectRoot, filePath);
}

async function getServiceAccountAccessToken(credentialsPath) {
	const resolvedPath = resolveFromProjectRoot(credentialsPath);
	const credentials = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
	const issuedAt = Math.floor(Date.now() / 1000);
	const expiresAt = issuedAt + 60 * 60;

	const header = { alg: 'RS256', typ: 'JWT' };
	const claimSet = {
		iss: credentials.client_email,
		scope: 'https://www.googleapis.com/auth/spreadsheets',
		aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
		iat: issuedAt,
		exp: expiresAt,
	};

	const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claimSet))}`;
	const signature = crypto
		.createSign('RSA-SHA256')
		.update(unsignedToken)
		.sign(credentials.private_key);
	const signedJwt = `${unsignedToken}.${base64UrlEncode(signature)}`;

	const params = new URLSearchParams({
		grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
		assertion: signedJwt,
	});

	const response = await axios.post(credentials.token_uri, params.toString(), {
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	});

	return response.data.access_token;
}

async function updateGoogleSheet({ accessToken, spreadsheetId, sheetName, values }) {
	const encodedSheet = encodeURIComponent(sheetName);
	const columnCount = values[0]?.length || 1;
	const rowCount = values.length || 1;
	const endColumn = columnIndexToLetter(columnCount);
	const range = `${sheetName}!A1:${endColumn}${rowCount}`;

	const client = axios.create({
		baseURL: 'https://sheets.googleapis.com/v4/spreadsheets',
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	await client.post(`/${spreadsheetId}/values/${encodedSheet}:clear`, {});
	await client.put(
		`/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
		{
			range,
			majorDimension: 'ROWS',
			values,
		}
	);
}

async function syncPricelistToGoogleSheet(sheetValues) {
	const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
	const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
	const sheetName = process.env.GOOGLE_SHEETS_TAB_NAME;
	const hasAnyConfig = credentialsPath || spreadsheetId || sheetName;

	if (!hasAnyConfig) {
		console.log('ℹ️ Google Sheets sync skipped (missing env vars).');
		return;
	}

	if (!credentialsPath || !spreadsheetId || !sheetName) {
		throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_SHEETS_SPREADSHEET_ID, or GOOGLE_SHEETS_TAB_NAME.');
	}

	const accessToken = await getServiceAccountAccessToken(credentialsPath);
	await updateGoogleSheet({
		accessToken,
		spreadsheetId,
		sheetName,
		values: sheetValues,
	});
	console.log(`✅ Google Sheet updated: ${spreadsheetId} (${sheetName})`);
}

async function exportPricelistToExcel() {
	try {
		const [columns] = await utilities.db.execute("SHOW COLUMNS FROM pricelist");
		const booleanColumns = columns
			.filter(col => col.Type.includes("tinyint(1)"))
			.map(col => col.Field);

		const orderedColumnNames = [
			"id", "localLineProductID", "category", "productName", "packageName",
			"retailSalesPrice", "lowest_weight", "highest_weight", "dff_unit_of_measure",
			"wholesalePricePerLb", "retailPackagePrice", "ffcsaPurchasePrice", "ffcsaMemberSalesPrice", "ffcsaGuestSalesPrice", "guestPercentOverRetail",
			"num_of_items", "available_on_ll", "description",
			"track_inventory", "stock_inventory", "visible"
		];

		const formatColumns = {
			"retailSalesPrice": "$#,##0.00",
			"lowest_weight": "0.00",
			"highest_weight": "0.00",
			"retailPackagePrice": "$#,##0.00",
			"wholesalePricePerLb": "$#,##0.00",
			"ffcsaPurchasePrice": "$#,##0.00",
			"ffcsaMemberSalesPrice": "$#,##0.00",
			"ffcsaGuestSalesPrice": "$#,##0.00",
			"guestPercentOverRetail": "0.0%"
		};

		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet('Pricelist');
		worksheet.addRow(orderedColumnNames);

		const sheetValues = [orderedColumnNames];
		const [rows] = await utilities.db.execute('SELECT id FROM pricelist ORDER BY category_id, productName');

		for (const row of rows) {
			const product = new Product(row.id);
			await product.init();

			const data = product.data;
			const pricing = product.pricing;

			const rowData = orderedColumnNames.map(column => {
				if (column === 'retailPackagePrice') {return pricing.retailPackagePrice;}
				if (column === 'guestPercentOverRetail') {return pricing.guestPercentOverRetail;}
				if (column === 'wholesalePricePerLb') {return pricing.wholesalePrice;}
				if (column === 'ffcsaPurchasePrice') return pricing.purchasePrice;
				if (column === 'ffcsaMemberSalesPrice') return pricing.memberSalesPrice;
				if (column === 'ffcsaGuestSalesPrice') return pricing.guestSalesPrice;
				if (column === 'retailSalesPrice') return Number(data[column]);
				if (column === 'lowest_weight') return Number(data[column]);
				if (column === 'highest_weight') return Number(data[column]);
				if (booleanColumns.includes(column)) return data[column] === 1 ? "True" : "False";
				return data[column] ?? "";
			});

			worksheet.addRow(rowData);
			sheetValues.push(rowData.map(value => (value === null || value === undefined) ? "" : value));
		}

		orderedColumnNames.forEach((column, index) => {
			if (formatColumns[column]) {
				worksheet.getColumn(index + 1).numFmt = formatColumns[column];
			}
		});

		const variableSheet = workbook.addWorksheet('Variables');
		variableSheet.getCell('A1').value = 'values';
		variableSheet.getCell('B1').value = 'keys';

		const variableMap = {
			DISCOUNT,
			WHOLESALE_DISCOUNT,
			MEMBER_MARKUP,
			GUEST_MARKUP,
			//utilities.DAIRY_MARKUP,
		};

		let rowIndex = 2;
		for (const [key, value] of Object.entries(variableMap)) {
			variableSheet.getCell(`A${rowIndex}`).value = value;
			variableSheet.getCell(`B${rowIndex}`).value = key;
			rowIndex++;
		}

		const outputFile = '../docs/masterPriceList.xlsx';
		await workbook.xlsx.writeFile(outputFile);
		console.log(`✅ Excel file created: ${outputFile}`);
		await syncPricelistToGoogleSheet(sheetValues);
		await utilities.db.end();
		console.log("✅ Database connection closed.");
		process.exit(0);

	} catch (error) {
		console.error('❌ Error exporting data:', error);
		process.exit(1);
	}
}

exportPricelistToExcel();
