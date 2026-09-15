const path = require('path');
const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });

const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { DateTime } = require('luxon');
const utilities = require('../src/utils/utilities.pricing');

const DEFAULT_SPREADSHEET_ID = '1q8NmiQxg_vde56FHpQ68SmM0S4R8PIPdc40pUd1fvkI';
const DEFAULT_SHEET_NAME = 'Form Responses 1';
const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
const SHEETS_BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const projectRoot = path.resolve(__dirname, '..');

function parseCliArgs(argv) {
	const positional = [];
	const options = {
		from: 'jdeck88@gmail.com',
		to: 'deckfamilyfarm@gmail.com',
		cc: 'jdeck88@gmail.com',
		title: 'Market Feedback Report',
		subject: null,
		spreadsheetId: process.env.MARKET_FEEDBACK_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID,
		sheetName: process.env.MARKET_FEEDBACK_SHEET_NAME || DEFAULT_SHEET_NAME,
		timeZone: process.env.REPORT_TIME_ZONE || DEFAULT_TIME_ZONE,
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

		if (key === 'spreadsheet-id') {
			options.spreadsheetId = value;
			continue;
		}

		if (key === 'sheet-name') {
			options.sheetName = value;
			continue;
		}

		if (key === 'time-zone') {
			options.timeZone = value;
			continue;
		}

		if (!['from', 'to', 'cc', 'title', 'subject'].includes(key)) {
			throw new Error(`Unknown option --${key}`);
		}

		options[key] = value;
	}

	const [startArg, endArg] = positional;
	return { startArg, endArg, options };
}

function base64UrlEncode(input) {
	const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
	return buffer
		.toString('base64')
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');
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
		scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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

async function buildGoogleSheetsClient() {
	const credentialsPath = process.env.MARKET_FEEDBACK_GOOGLE_APPLICATION_CREDENTIALS
		|| process.env.GOOGLE_APPLICATION_CREDENTIALS;
	const apiKey = process.env.MARKET_FEEDBACK_GOOGLE_SHEETS_API_KEY
		|| process.env.GOOGLE_SHEETS_API_KEY;

	if (credentialsPath) {
		const accessToken = await getServiceAccountAccessToken(credentialsPath);
		return axios.create({
			baseURL: SHEETS_BASE_URL,
			headers: { Authorization: `Bearer ${accessToken}` },
		});
	}

	if (apiKey) {
		const client = axios.create({ baseURL: SHEETS_BASE_URL });
		client.interceptors.request.use(config => {
			config.params = { ...(config.params || {}), key: apiKey };
			return config;
		});
		return client;
	}

	throw new Error('Missing Google Sheets credentials. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SHEETS_API_KEY.');
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

function normalizeHeader(value) {
	return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function findColumn(headers, description, matcher, required = true) {
	const index = headers.findIndex((header) => matcher(normalizeHeader(header)));
	if (index === -1 && required) {
		throw new Error(`Could not find required column: ${description}`);
	}
	return index;
}

function findColumns(headers, matcher) {
	return headers
		.map((header, index) => ({ header, index }))
		.filter(({ header }) => matcher(normalizeHeader(header)))
		.map(({ index }) => index);
}

function getPreviousCompletedWeekendRange(timeZone) {
	const today = DateTime.now().setZone(timeZone).startOf('day');
	const daysSinceSunday = today.weekday === 7 ? 7 : today.weekday;
	const end = today.minus({ days: daysSinceSunday });
	const start = end.minus({ days: 1 });
	return {
		start: start.toISODate(),
		end: end.toISODate(),
	};
}

function parseMarketDate(value, timeZone) {
	const text = String(value || '').trim();
	if (!text) return null;

	const iso = DateTime.fromISO(text, { zone: timeZone });
	if (iso.isValid) return iso.startOf('day');

	const formats = ['M/d/yyyy', 'M/d/yy', 'MM/dd/yyyy', 'MM/dd/yy'];
	for (const format of formats) {
		const parsed = DateTime.fromFormat(text, format, { zone: timeZone });
		if (parsed.isValid) return parsed.startOf('day');
	}

	const fallback = DateTime.fromJSDate(new Date(text), { zone: timeZone });
	return fallback.isValid ? fallback.startOf('day') : null;
}

function parseTimestamp(value, timeZone) {
	const text = String(value || '').trim();
	if (!text) return null;

	const formats = [
		'M/d/yyyy H:mm:ss',
		'M/d/yyyy HH:mm:ss',
		'M/d/yy H:mm:ss',
		'M/d/yy HH:mm:ss',
		'MM/dd/yyyy H:mm:ss',
		'MM/dd/yyyy HH:mm:ss',
	];

	for (const format of formats) {
		const parsed = DateTime.fromFormat(text, format, { zone: timeZone });
		if (parsed.isValid) return parsed;
	}

	const iso = DateTime.fromISO(text, { zone: timeZone });
	return iso.isValid ? iso : null;
}

function isMeaningfulText(value) {
	const text = String(value || '').trim();
	if (!text) return false;
	const normalized = text.toLowerCase().replace(/[.\s]+$/g, '');
	return !['n/a', 'na', 'none', 'no', '-', 'u'].includes(normalized);
}

function normalizeInlineText(value) {
	return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseMoneyToCents(value) {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.round(value * 100);
	}

	const text = String(value).trim();
	if (!isMeaningfulText(text)) return null;

	const match = text.replace(/,/g, '').match(/-?\$?\s*\d+(?:\.\d+)?/);
	if (!match) return null;

	const amount = Number(match[0].replace(/[$\s]/g, ''));
	return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function cleanExpenseDescription(value) {
	const text = normalizeInlineText(value);
	const withoutMoney = text
		.replace(/\(?-?\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:in\s+tokens)?\)?/i, '')
		.replace(/\s+([.,;:])/g, '$1')
		.replace(/\.\s*\./g, '.')
		.replace(/\s+/g, ' ')
		.replace(/^[\s:,-]+|[\s:,-]+$/g, '')
		.trim();
	return withoutMoney || text;
}

function formatMoney(cents) {
	if (cents === null || cents === undefined) return 'MISSING';
	return `$${(cents / 100).toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

function formatLine(label, amount = null, prefix = '', note = '') {
	const labelCol = String(label).padEnd(30);
	const amountCol = amount !== null ? `${prefix}${formatMoney(amount).padStart(12)}` : '';
	const spacing = amount !== null ? '  ' : '';
	return `  • ${labelCol}${amountCol}${spacing}${note}\n`;
}

function escapeHtml(text) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function addUnique(list, value) {
	if (!isMeaningfulText(value)) return;
	const cleaned = normalizeInlineText(value);
	const key = cleaned.toLowerCase();
	if (!list.some(existing => existing.toLowerCase() === key)) {
		list.push(cleaned);
	}
}

function updateLatestMoney(group, field, cents, timestamp) {
	if (cents === null) return;

	const timestampMillis = timestamp?.toMillis?.() || 0;
	const currentTimestamp = group[`${field}TimestampMillis`] || -1;
	if (group[`${field}Cents`] === null || timestampMillis >= currentTimestamp) {
		group[`${field}Cents`] = cents;
		group[`${field}TimestampMillis`] = timestampMillis;
	}
}

async function fetchFeedbackValues({ client, spreadsheetId, sheetName }) {
	const metadataResponse = await client.get(`/${spreadsheetId}`, {
		params: {
			fields: 'properties.title,sheets.properties',
		},
	});

	const spreadsheet = metadataResponse.data;
	const sheet = (spreadsheet.sheets || [])
		.map(item => item.properties)
		.find(properties => properties.title === sheetName);

	if (!sheet) {
		const availableSheets = (spreadsheet.sheets || [])
			.map(item => item.properties?.title)
			.filter(Boolean)
			.join(', ');
		throw new Error(`Sheet "${sheetName}" not found. Available sheets: ${availableSheets}`);
	}

	const rowCount = sheet.gridProperties?.rowCount || 1000;
	const columnCount = sheet.gridProperties?.columnCount || 36;
	const endColumn = columnIndexToLetter(columnCount);
	const escapedSheetName = sheetName.replace(/'/g, "''");
	const range = `'${escapedSheetName}'!A1:${endColumn}${rowCount}`;
	const valuesResponse = await client.get(`/${spreadsheetId}/values/${encodeURIComponent(range)}`, {
		params: {
			valueRenderOption: 'FORMATTED_VALUE',
		},
	});

	return {
		title: spreadsheet.properties?.title || spreadsheetId,
		sheetName,
		values: valuesResponse.data.values || [],
	};
}

function buildColumnMap(headers) {
	return {
		marketDate: findColumn(headers, 'Market Date', header => header === 'market date'),
		timestamp: findColumn(headers, 'Timestamp', header => header === 'timestamp'),
		market: findColumn(headers, 'Market', header => header.includes("which farmers' market")),
		workers: findColumn(headers, 'Workers', header => header.includes('who worked at this market')),
		boothPhoto: findColumn(headers, 'Booth photo confirmation', header => header.startsWith('i sent a photo'), false),
		soldOut: findColumn(headers, 'Sellouts', header => header.includes('sell out completely'), false),
		pop: findColumn(headers, 'Pick-of-the-Pasture feedback', header => header.includes('pick-of-the-pasture') || header.includes(' pop '), false),
		issues: findColumn(headers, 'Issues', header => header.includes('issues arise'), false),
		questions: findColumn(headers, 'Customer questions', header => header.includes('questions did customers ask'), false),
		positive: findColumn(headers, 'Positive feedback', header => header.includes('positive feedback'), false),
		cash: findColumn(headers, 'Cash Deposit', header => header === 'cash deposit'),
		tokens: findColumn(headers, 'Tokens', header => header === 'tokens'),
		expenses: findColumns(headers, header => header.startsWith('fees/expenses')),
	};
}

function valueAt(row, index) {
	return index >= 0 ? row[index] : '';
}

function buildRecord(row, rowNumber, columns, timeZone) {
	const marketDate = parseMarketDate(valueAt(row, columns.marketDate), timeZone);
	if (!marketDate) return null;

	const timestamp = parseTimestamp(valueAt(row, columns.timestamp), timeZone);
	const market = normalizeInlineText(valueAt(row, columns.market));
	const workers = normalizeInlineText(valueAt(row, columns.workers));

	if (!market) return null;

	const expenses = columns.expenses
		.map(index => valueAt(row, index))
		.filter(isMeaningfulText)
		.map(raw => ({
			raw: normalizeInlineText(raw),
			description: cleanExpenseDescription(raw),
			amountCents: parseMoneyToCents(raw),
		}));

	return {
		rowNumber,
		marketDate,
		marketDateIso: marketDate.toISODate(),
		timestamp,
		market,
		workers,
		boothPhoto: normalizeInlineText(valueAt(row, columns.boothPhoto)),
		soldOut: normalizeInlineText(valueAt(row, columns.soldOut)),
		pop: normalizeInlineText(valueAt(row, columns.pop)),
		issues: normalizeInlineText(valueAt(row, columns.issues)),
		questions: normalizeInlineText(valueAt(row, columns.questions)),
		positive: normalizeInlineText(valueAt(row, columns.positive)),
		cashCents: parseMoneyToCents(valueAt(row, columns.cash)),
		tokensCents: parseMoneyToCents(valueAt(row, columns.tokens)),
		expenses,
	};
}

function dedupeRecords(records) {
	const seen = new Set();
	const uniqueRecords = [];
	let duplicateCount = 0;

	for (const record of records) {
		const key = JSON.stringify({
			marketDateIso: record.marketDateIso,
			market: record.market.toLowerCase(),
			workers: record.workers.toLowerCase(),
			soldOut: record.soldOut.toLowerCase(),
			pop: record.pop.toLowerCase(),
			issues: record.issues.toLowerCase(),
			questions: record.questions.toLowerCase(),
			positive: record.positive.toLowerCase(),
			cashCents: record.cashCents,
			tokensCents: record.tokensCents,
			expenses: record.expenses.map(expense => expense.raw.toLowerCase()),
		});

		if (seen.has(key)) {
			duplicateCount++;
			continue;
		}

		seen.add(key);
		uniqueRecords.push(record);
	}

	return { uniqueRecords, duplicateCount };
}

function consolidateRecords(records) {
	const groups = new Map();

	for (const record of records) {
		const key = `${record.marketDateIso}|${record.market.toLowerCase()}`;
		if (!groups.has(key)) {
			groups.set(key, {
				marketDate: record.marketDate,
				marketDateIso: record.marketDateIso,
				market: record.market,
				workers: [],
				cashCents: null,
				cashTimestampMillis: -1,
				tokensCents: null,
				tokensTimestampMillis: -1,
				expenses: [],
				soldOut: [],
				pop: [],
				issues: [],
				questions: [],
				positive: [],
				boothPhotoMissing: false,
				sourceRows: [],
			});
		}

		const group = groups.get(key);
		group.sourceRows.push(record.rowNumber);
		addUnique(group.workers, record.workers);
		updateLatestMoney(group, 'cash', record.cashCents, record.timestamp);
		updateLatestMoney(group, 'tokens', record.tokensCents, record.timestamp);
		addUnique(group.soldOut, record.soldOut);
		addUnique(group.pop, record.pop);
		addUnique(group.issues, record.issues);
		addUnique(group.questions, record.questions);
		addUnique(group.positive, record.positive);

		if (record.boothPhoto && record.boothPhoto.toLowerCase() !== 'yes') {
			group.boothPhotoMissing = true;
		}

		for (const expense of record.expenses) {
			const expenseKey = `${expense.amountCents}|${expense.description.toLowerCase()}`;
			if (!group.expenses.some(existing => existing.key === expenseKey)) {
				group.expenses.push({
					key: expenseKey,
					market: group.market,
					marketDate: group.marketDate,
					description: expense.description,
					amountCents: expense.amountCents,
				});
			}
		}
	}

	return Array.from(groups.values())
		.sort((a, b) => {
			const dateCompare = a.marketDate.toMillis() - b.marketDate.toMillis();
			if (dateCompare !== 0) return dateCompare;
			return a.market.localeCompare(b.market);
		});
}

function addTextSection(summaryText, title, entries, field) {
	const lines = [];
	for (const entry of entries) {
		for (const value of entry[field]) {
			lines.push(`  • ${entry.market}: ${value}\n`);
		}
	}

	if (!lines.length) return summaryText;
	return `${summaryText}\n${title}:\n${lines.join('')}`;
}

function buildReport({ entries, startArg, endArg, options, sheetTitle, duplicateCount, rawRecordCount }) {
	const generated = DateTime.now()
		.setZone(options.timeZone)
		.toFormat('yyyy-MM-dd HH:mm');
	let summaryText = `${options.title.toUpperCase()}: ${startArg} to ${endArg}\n`;
	summaryText += `Generated on ${generated} ${options.timeZone}\n`;
	summaryText += `Source: ${sheetTitle}\n`;

	if (!entries.length) {
		summaryText += `\nNo market feedback submissions found for this date range.\n`;
		return summaryText;
	}

	summaryText += `\nMARKETS WORKED:\n`;
	for (const entry of entries) {
		const dateLabel = entry.marketDate.toFormat('M/d');
		const workers = entry.workers.length ? entry.workers.join(', ') : 'MISSING';
		summaryText += `  • ${entry.market.padEnd(18)}${dateLabel.padEnd(6)}${workers}\n`;
	}

	let cashTotal = 0;
	let tokensTotal = 0;
	const missingCash = [];
	const missingTokens = [];

	summaryText += `\nCASH DEPOSITS & TOKENS:\n`;
	for (const entry of entries) {
		const label = `${entry.market} (${entry.marketDate.toFormat('M/d')})`.padEnd(24);
		if (entry.cashCents === null) missingCash.push(entry.market);
		else cashTotal += entry.cashCents;
		if (entry.tokensCents === null) missingTokens.push(entry.market);
		else tokensTotal += entry.tokensCents;
		summaryText += `  • ${label}Cash ${formatMoney(entry.cashCents).padEnd(12)} Tokens ${formatMoney(entry.tokensCents)}\n`;
	}
	summaryText += `\n`;
	summaryText += formatLine('Total Cash Deposits', cashTotal);
	summaryText += formatLine('Total Tokens', tokensTotal);

	const expenses = entries.flatMap(entry => entry.expenses);
	let expenseTotal = 0;
	summaryText += `\nFEES & EXPENSES:\n`;
	if (!expenses.length) {
		summaryText += `  • None reported\n`;
	} else {
		for (const expense of expenses) {
			const label = `${expense.market} (${expense.marketDate.toFormat('M/d')})`;
			if (expense.amountCents !== null) expenseTotal += expense.amountCents;
			summaryText += formatLine(label, expense.amountCents, '', expense.description);
		}
		summaryText += `\n`;
		summaryText += formatLine('Total Fees/Expenses', expenseTotal);
	}

	summaryText = addTextSection(summaryText, 'SELL OUTS / LOW STOCK', entries, 'soldOut');
	summaryText = addTextSection(summaryText, 'PICK-OF-THE-PASTURE FEEDBACK', entries, 'pop');
	summaryText = addTextSection(summaryText, 'ISSUES / BOOTH PROBLEMS', entries, 'issues');
	summaryText = addTextSection(summaryText, 'CUSTOMER QUESTIONS', entries, 'questions');
	summaryText = addTextSection(summaryText, 'POSITIVE FEEDBACK', entries, 'positive');

	const notes = [];
	if (duplicateCount > 0) {
		notes.push(`${duplicateCount} duplicate submission${duplicateCount === 1 ? '' : 's'} omitted.`);
	}

	const consolidatedCount = rawRecordCount - duplicateCount - entries.length;
	if (consolidatedCount > 0) {
		notes.push(`${consolidatedCount} extra submission${consolidatedCount === 1 ? '' : 's'} consolidated into matching market/date rows.`);
	}

	if (missingCash.length) {
		notes.push(`Missing cash deposit: ${missingCash.join(', ')}.`);
	}

	if (missingTokens.length) {
		notes.push(`Missing tokens: ${missingTokens.join(', ')}.`);
	}

	if (notes.length) {
		summaryText += `\nNOTES:\n`;
		for (const note of notes) {
			summaryText += `  • ${note}\n`;
		}
	}

	return summaryText;
}

function logAxiosError(context, error) {
	if (error?.response) {
		const { status, statusText, data } = error.response;
		console.error(`❌ ${context} failed (${status} ${statusText})`);
		if (data) console.error('Details:', JSON.stringify(data, null, 2));
		return;
	}

	console.error(`❌ ${context} failed: ${error?.message || error}`);
}

async function main() {
	let { startArg, endArg, options } = parseCliArgs(process.argv.slice(2));
	if (!startArg) {
		({ start: startArg, end: endArg } = getPreviousCompletedWeekendRange(options.timeZone));
	} else if (!endArg) {
		endArg = startArg;
	}

	const startDate = DateTime.fromISO(startArg, { zone: options.timeZone }).startOf('day');
	const endDate = DateTime.fromISO(endArg, { zone: options.timeZone }).startOf('day');
	if (!startDate.isValid || !endDate.isValid) {
		throw new Error('Start and end dates must be YYYY-MM-DD values.');
	}

	const client = await buildGoogleSheetsClient();
	const { title: sheetTitle, values } = await fetchFeedbackValues({
		client,
		spreadsheetId: options.spreadsheetId,
		sheetName: options.sheetName,
	});

	const headers = values[0] || [];
	const columns = buildColumnMap(headers);
	const records = values.slice(1)
		.map((row, index) => buildRecord(row, index + 2, columns, options.timeZone))
		.filter(Boolean)
		.filter(record => record.marketDate >= startDate && record.marketDate <= endDate);
	const { uniqueRecords, duplicateCount } = dedupeRecords(records);
	const entries = consolidateRecords(uniqueRecords);

	const summaryText = buildReport({
		entries,
		startArg,
		endArg,
		options,
		sheetTitle,
		duplicateCount,
		rawRecordCount: records.length,
	});

	const subject = options.subject || `${options.title}: ${startArg} to ${endArg}`;
	const emailOptions = {
		from: options.from,
		to: options.to,
		subject,
		text: summaryText,
		html: `<pre>${escapeHtml(summaryText)}</pre>`,
	};
	if (options.cc) emailOptions.cc = options.cc;

	if (options.dryRun) {
		console.log(`DRY RUN: would send "${subject}" to ${options.to}${options.cc ? ` cc ${options.cc}` : ''}`);
		console.log(summaryText);
		process.exit(0);
	}

	await utilities.sendEmail(emailOptions);
	console.log('📧 Email sent.');
	process.exit(0);
}

main().catch(error => {
	logAxiosError('Market feedback report', error);
	process.exit(1);
});
