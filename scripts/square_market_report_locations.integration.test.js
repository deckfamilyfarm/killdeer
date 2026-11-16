const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('full report moves accounting together, refreshes late notes, and filters after assignment', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'market-location-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'preload.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const Module = require('node:module');
    const original = Module._load;
    const locations = ['Hollywood', 'Montavilla'].map(name => ({id:name,name,status:'ACTIVE'}));
    const orders = [
      { id:'sat',location_id:'Hollywood',created_at:'2026-11-14T10:00:00-08:00',total_money:{amount:2000},
        tenders:[{type:'CARD',payment_id:'sat',amount_money:{amount:2000}}]},
      { id:'wrong',location_id:'Hollywood',created_at:'2026-11-15T10:00:00-08:00',total_money:{amount:1500},
        total_discount_money:{amount:75},total_tip_money:{amount:50},total_service_charge_money:{amount:25},
        tenders:[{type:'CASH',payment_id:'cash',amount_money:{amount:500}},
          {type:'CARD',payment_id:'card',amount_money:{amount:1000}}]},
      { id:'later',location_id:'Montavilla',created_at:'2026-11-15T12:40:00-08:00',total_money:{amount:3000},
        tenders:[{type:'CARD',payment_id:'later',amount_money:{amount:3000}}]},
    ];
    Module._load = function(request,parent,isMain) {
      if(request==='axios') return {
        get: async url => {
          if(url.includes('/locations')) return {data:{locations}};
          if(url.includes('/catalog/list')) return {data:{objects:[]}};
          const id=url.split('/').pop();
          if(process.env.PAYMENT_FAILURE && id==='cash') throw new Error('Unavailable');
          const order=orders.find(o=>o.tenders.some(t=>t.payment_id===id));
          if(!order) throw new Error('Unexpected request '+url);
          return {data:{payment:{id,status:'COMPLETED',created_at:order.created_at,location_id:order.location_id,
            device_details:{device_id:process.env.NO_SWITCH && id==='later' ? 'other' : 'ipad'},
            processing_fee:[{amount_money:{amount:id==='cash'?0:30}}],
            refunded_money:{amount:id==='cash'?50:id==='card'?100:0}}}};
        },
        post: async (url,body) => ({data:{orders:orders.filter(o=>o.location_id===body.location_ids[0])}}),
      };
      if(request==='../src/utils/utilities.pricing') return {
        db:{query:async()=>[[]]}, sendEmail:async options=>fs.writeFileSync(process.env.EMAIL_OUTPUT,JSON.stringify(options)),
      };
      if(request==='./square_market_report_ledger') {
        const real=original.call(this,request,parent,isMain);
        return {...real,resolveCreditBalanceNames:async balances=>balances,fetchMarketActivity:async()=>({
          creditBalances:{asOfDate:'2026-11-15',entries:[],totalCents:0},
          categories:Object.fromEntries(['fmSupplies','fmRepTrades','fmTillCashSupplies'].map(k=>[k,{entries:[],totalCents:0}]))})};
      }
      if(request==='./market_feedback_report') {
        const real=original.call(this,request,parent,isMain);
        const headers=['Market Date','Timestamp',"Which farmers' market did you work at?",'Who worked at this market today?','Cash Deposit','Tokens'];
        const columns=real.buildColumnMap(headers);
        return {...real,fetchMarketFeedback:async()=>({sheetTitle:'Yellow Notes',records:[
          real.buildRecord(['11/15/2026','11/16/2026 8:37:32','Montavilla','Stephanie','3','1'],93,columns,'America/Los_Angeles')
        ]})};
      }
      if(request==='./square_market_report_sheet') {
        const real=original.call(this,request,parent,isMain);
        return {...real,updateReconciliationSheet:async options=>{
          fs.writeFileSync(process.env.SHEET_OUTPUT,JSON.stringify({...options,
            rows:real.buildRows(options.locations,options.summaries,options.deposits,options.notes)}));
          return options.dryRun?'DRY RUN':'CREATED test: https://docs.google.com/spreadsheets/d/test/edit#gid=1';
        }};
      }
      return original.call(this,request,parent,isMain);
    };
  `);
  const run = (extra = [], env = {}) => {
    const output = path.join(directory, 'sheet.json');
    const email = path.join(directory, 'email.json');
    fs.rmSync(email, { force: true });
    const result = spawnSync(process.execPath, ['--require', preload,
      path.join(__dirname, 'square_market_report.js'), '2026-11-14', '2026-11-15', ...extra], {
      encoding: 'utf8', env: { ...process.env, NODE_ENV: 'location-integration-test',
        SHEET_OUTPUT: output, EMAIL_OUTPUT: email, NO_SWITCH: '', PAYMENT_FAILURE: '', ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    return { result, sheet: JSON.parse(fs.readFileSync(output)), email: fs.existsSync(email) ? JSON.parse(fs.readFileSync(email)) : null };
  };
  const baseline = run(['--dry-run'], { NO_SWITCH: '1' });
  const corrected = run(['--dry-run']);
  assert.equal(corrected.email, null);
  for (const field of ['orderCount', 'locationTotal', 'discounts', 'tips', 'serviceCharges', 'cash', 'card', 'fees', 'cash_refunds', 'card_refunds', 'net_deposit']) {
    const sum = sheet => Object.values(sheet.summaries).reduce((total, s) => total + s[field], 0);
    assert.equal(sum(corrected.sheet), sum(baseline.sheet), field);
  }
  const montavilla = corrected.sheet.summaries.Montavilla;
  assert.equal(montavilla.orderCount, 2);
  assert.equal(montavilla.locationTotal, 4500);
  assert.equal(montavilla.cash - montavilla.cash_refunds, 450);
  assert.equal(montavilla.net_deposit, 3840);
  assert.equal(montavilla.discounts, 75);
  assert.equal(montavilla.tips, 50);
  assert.equal(montavilla.serviceCharges, 25);
  assert.equal(corrected.sheet.summaries.Hollywood.locationTotal, 2000);
  assert.match(corrected.result.stdout, /1 orders \/ 2 payments, \$15.00/);
  assert.match(corrected.result.stdout, /LATE YELLOW NOTES.*2026-11-16 08:37:32 PST/);
  const row = corrected.sheet.rows.find(row => row.values[0].userEnteredValue?.stringValue === 'Montavilla');
  assert.equal(row.values[2].userEnteredValue.numberValue, 4.5);
  assert.equal(row.values[3].userEnteredValue.numberValue, 3);
  assert.equal(row.values[4].userEnteredValue.numberValue, 1);
  assert.match(row.values[9].userEnteredValue.stringValue, /AUTO-CORRECTED[\s\S]*LATE YELLOW NOTES/);
  const filtered = run(['Montavilla', '--dry-run']);
  assert.deepEqual(Object.keys(filtered.sheet.summaries), ['Montavilla']);
  assert.equal(filtered.sheet.summaries.Montavilla.locationTotal, 4500);
  const failed = run(['--dry-run'], { PAYMENT_FAILURE: '1' });
  assert.equal(failed.sheet.summaries.Hollywood.locationTotal, 3500);
  assert.match(failed.result.stdout, /NEEDS REVIEW/);
  assert.match(failed.result.stdout, /fees\/refunds may be incomplete/);
  const sent = run(['--subject', 'CORRECTED: Square Market & Yellow Notes Report: 2026-11-14 to 2026-11-15']);
  assert.equal(sent.email.to, 'deckfamilyfarm@gmail.com');
  assert.equal(sent.email.cc, 'jdeck88@gmail.com');
  assert.match(sent.email.subject, /^CORRECTED:/);
  assert.match(sent.email.text, /AUTO-CORRECTED/);
  assert.match(sent.email.text, /LATE YELLOW NOTES/);
});
