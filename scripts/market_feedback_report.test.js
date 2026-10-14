const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildColumnMap, buildRecord, sendReportErrorAlert } = require('./market_feedback_report');

const TIME_ZONE = 'America/Los_Angeles';
const MARKET_HEADER = "Which farmers' market did you work at?";
const WORKERS_HEADER = 'Who worked at this market today?';
const REQUIRED_HEADERS = ['Timestamp', MARKET_HEADER, WORKERS_HEADER, 'Cash Deposit', 'Tokens'];

test('inserting and reordering columns preserves market dates and amounts', () => {
	const headers = [
		MARKET_HEADER,
		'Any suggestions for optimizing stock in the back-up cooler?',
		'Tokens',
		'Timestamp',
		' Market   Date ',
		WORKERS_HEADER,
		'Cash Deposit',
		'Fees/Expenses #1 (description and cost)',
	];
	const row = ['PSU', 'More ice', '$25', '10/11/2026 15:55:33', '10/10/2026', 'Two workers', '$100', '$10 booth fee'];
	const columns = buildColumnMap(headers, [row], TIME_ZONE);
	const record = buildRecord(row, 2, columns, TIME_ZONE);

	assert.equal(record.marketDateIso, '2026-10-10');
	assert.equal(record.timestamp.toISODate(), '2026-10-11');
	assert.equal(record.market, 'PSU');
	assert.equal(record.workers, 'Two workers');
	assert.equal(record.cashCents, 10000);
	assert.equal(record.tokensCents, 2500);
	assert.equal(record.expenses[0].amountCents, 1000);
});

test('recovers the current date-labeled header without using the submission timestamp', () => {
	const headers = ['10/10/2026', 'Timestamp', 'Feb 8 2025', MARKET_HEADER, WORKERS_HEADER, 'Cash Deposit', 'Tokens', 'Column 29', 'Feb 8 2025'];
	const rows = [
		[],
		['10/10/2026', '10/11/2026 15:55:33', null, 'PSU', 'Two workers', '$100', '$25'],
		['10/11/2026', '10/11/2026 16:34:33', null, 'Springfield', 'A worker', '$50', '$10'],
	];
	const columns = buildColumnMap(headers, rows, TIME_ZONE);
	const record = buildRecord(rows[1], 3, columns, TIME_ZONE);

	assert.equal(record.marketDateIso, '2026-10-10');
	assert.equal(record.timestamp.toISODate(), '2026-10-11');
	assert.equal(record.cashCents, 10000);
	assert.equal(record.tokensCents, 2500);
});

test('recovers a blank header with date-only values and ignores empty cells', () => {
	const headers = ['', ...REQUIRED_HEADERS];
	const rows = [[], ['  '], ['2026-10-10', '10/11/2026 15:55:33', 'PSU', 'Two workers', '100', '25']];
	const columns = buildColumnMap(headers, rows, TIME_ZONE);
	assert.equal(buildRecord(rows[2], 4, columns, TIME_ZONE).marketDateIso, '2026-10-10');
});

test('the named market-date column takes precedence over other date columns', () => {
	const headers = ['10/11/2026', 'Market Date', ...REQUIRED_HEADERS];
	const row = ['10/11/2026', '10/10/2026', '10/11/2026 15:55:33', 'PSU', 'Two workers', '100', '25'];
	const columns = buildColumnMap(headers, [row], TIME_ZONE);
	assert.equal(buildRecord(row, 2, columns, TIME_ZONE).marketDateIso, '2026-10-10');
});

test('ambiguous date columns fail with column letters and repair instructions', () => {
	const headers = ['10/10/2026', 'Feb 8 2025', ...REQUIRED_HEADERS];
	const row = ['10/10/2026', '10/11/2026', '10/11/2026 15:55:33', 'PSU', 'Two workers', '100', '25'];
	assert.throws(() => buildColumnMap(headers, [row], TIME_ZONE), /Multiple date columns match: A, B.*Rename the market-date column header/);
});

test('missing or unusable dates fail instead of falling back to timestamps or other fields', () => {
	for (const [header, value] of [
		['10/10/2026', '10/11/2026 15:55:33'],
		['10/10/2026', '100'],
		['10/10/2026', '2/30/2026'],
		['10/10/2026', ''],
		['Delivery Date', '10/10/2026'],
	]) {
		const headers = [header, ...REQUIRED_HEADERS];
		const row = [value, '10/11/2026 15:55:33', 'PSU', 'Two workers', '100', '25'];
		assert.throws(() => buildColumnMap(headers, [row], TIME_ZONE), /Could not find required column: Market Date.*Rename/);
	}
	assert.throws(() => buildColumnMap(['10/10/2026', ...REQUIRED_HEADERS], [], TIME_ZONE), /Could not find required column: Market Date/);
});

test('mixed date and non-date values cannot identify a missing date header', () => {
	const headers = ['10/10/2026', ...REQUIRED_HEADERS];
	const rows = [
		['10/10/2026', '10/11/2026 15:55:33', 'PSU', 'Two workers', '100', '25'],
		['not a date', '10/11/2026 16:34:33', 'Springfield', 'A worker', '50', '10'],
	];
	assert.throws(() => buildColumnMap(headers, rows, TIME_ZONE), /Could not find required column: Market Date/);
});

test('error alerts go to John with the original failure and close the mail transport', async () => {
	let message;
	let closed = false;
	const failure = new Error('Could not find required column: Market Date');
	await sendReportErrorAlert(failure, () => ({
		async sendMail(email) { message = email; },
		close() { closed = true; },
	}));
	assert.equal(message.to, 'jdeck88@gmail.com');
	assert.match(message.subject, /^ERROR: Yellow Notes \/ Market Feedback Report: \d{4}-\d{2}-\d{2}$/);
	assert.match(message.text, /Could not find required column: Market Date/);
	assert.match(message.text, /Script: .*market_feedback_report\.js/);
	assert.equal(closed, true);
});

test('failed alert delivery closes the transport and exposes the email failure', async () => {
	let closed = false;
	await assert.rejects(sendReportErrorAlert(new Error('Report failed'), () => ({
		async sendMail() { throw new Error('SMTP unavailable'); },
		close() { closed = true; },
	})), /SMTP unavailable/);
	assert.equal(closed, true);
});

function runFailingReport(t, scenario) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'market-feedback-alert-test-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const preloadPath = path.join(directory, 'preload.cjs');
	const alertsPath = path.join(directory, 'alerts.json');
	fs.writeFileSync(preloadPath, `
		const fs = require('node:fs');
		const path = require('node:path');
		const Module = require('node:module');
		const originalLoad = Module._load;
		const alerts = [];
		Module._load = function(request, parent, isMain) {
			if (request === 'nodemailer') return { createTransport() { return {
				async sendMail(message) {
					if (${JSON.stringify(scenario)} === 'smtp') throw new Error('SMTP unavailable');
					await new Promise(resolve => setTimeout(resolve, 10));
					alerts.push(message);
					fs.writeFileSync(path.join(__dirname, 'alerts.json'), JSON.stringify(alerts));
				},
				close() {},
			}; } };
			if (request === 'axios' && ${JSON.stringify(scenario)} === 'startup') {
				throw new Error('Simulated missing axios dependency');
			}
			if (request === 'axios' && ${JSON.stringify(scenario)} === 'timeout') return {
				create() { return {
					interceptors: { request: { use() {} } },
					get() { return new Promise(() => {}); },
				}; },
			};
			return originalLoad.call(this, request, parent, isMain);
		};
		if (${JSON.stringify(scenario)} === 'timeout') {
			const originalSetTimeout = global.setTimeout;
			global.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, Math.min(delay, 50), ...args);
		}
	`);
	const args = scenario === 'timeout' ? ['--spreadsheet-id', 'offline-test'] : ['--unknown-option', 'test'];
	const child = spawnSync(process.execPath, [
		'--require', preloadPath, path.join(__dirname, 'market_feedback_report.js'), ...args,
	], {
		encoding: 'utf8',
		timeout: 5000,
		env: {
			...process.env,
			NODE_ENV: 'market-feedback-alert-test',
			MARKET_FEEDBACK_GOOGLE_APPLICATION_CREDENTIALS: '',
			GOOGLE_APPLICATION_CREDENTIALS: '',
			MARKET_FEEDBACK_GOOGLE_SHEETS_API_KEY: 'offline-test',
		},
	});
	assert.ifError(child.error);
	assert.equal(child.status, 1, child.stderr);
	return {
		child,
		alerts: fs.existsSync(alertsPath) ? JSON.parse(fs.readFileSync(alertsPath, 'utf8')) : [],
	};
}

test('CLI report failures await one error email before exiting unsuccessfully', (t) => {
	const { child, alerts } = runFailingReport(t, 'runtime');
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].to, 'jdeck88@gmail.com');
	assert.match(alerts[0].text, /Unknown option --unknown-option/);
	assert.match(child.stderr, /Report error alert sent/);
});

test('startup dependency failures also send an error email', (t) => {
	const { alerts } = runFailingReport(t, 'startup');
	assert.equal(alerts.length, 1);
	assert.match(alerts[0].text, /Simulated missing axios dependency/);
});

test('a stalled report sends an error email and exits', (t) => {
	const { alerts } = runFailingReport(t, 'timeout');
	assert.equal(alerts.length, 1);
	assert.match(alerts[0].text, /Report did not finish within five minutes/);
});

test('an email outage preserves the original report failure and unsuccessful exit', (t) => {
	const { child, alerts } = runFailingReport(t, 'smtp');
	assert.equal(alerts.length, 0);
	assert.match(child.stderr, /Unknown option --unknown-option/);
	assert.match(child.stderr, /Could not send report error alert: SMTP unavailable/);
});
