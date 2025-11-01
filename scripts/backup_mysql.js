// backups/backup.js
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const mysqldump = require('mysqldump');

const env = process.env.NODE_ENV || 'production';
const envPath = path.resolve(__dirname, `../.env.${env}`);
require('dotenv').config({ path: envPath });

console.log(`✅ Loaded environment: ${env} from ${envPath}`);

// ------------ Env → DB Configs ------------
const dbConfigs = [
  {
    label: 'DFF',
    host: process.env.DFF_DB_HOST,
    port: process.env.DFF_DB_PORT || 3306,
    user: process.env.DFF_DB_USER,
    password: process.env.DFF_DB_PASSWORD,
    database: process.env.DFF_DB_DATABASE,
  },
  {
    label: 'TIMESHEETS',
    host: process.env.TIMESHEETS_DB_HOST,
    port: process.env.TIMESHEETS_DB_PORT || 3306,
    user: process.env.TIMESHEETS_DB_USER,
    password: process.env.TIMESHEETS_DB_PASSWORD,
    database: process.env.TIMESHEETS_DB_DATABASE,
  },
];

// Validate presence (host/user/database are minimum)
function isValid(cfg) {
  return cfg && cfg.host && cfg.user && cfg.database;
}

// ------------ Date helpers ------------
const now = new Date();
const yyyy = now.getFullYear();
const mm = String(now.getMonth() + 1).padStart(2, '0');
const dd = String(now.getDate()).padStart(2, '0');
const iso = now.toISOString().replace(/[:.]/g, '-');
// Simple "week of month" number
const week = Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7);

// ------------ Backup sets & base dir ------------
const baseDir = path.resolve(__dirname, '../backups');
const backupSetsFor = (dbName) => ([
  { name: 'daily',   filename: `${dbName}_${yyyy}-${mm}-${dd}.sql.gz` },
  { name: 'weekly',  filename: `${dbName}_${yyyy}-W${week}.sql.gz` },
  { name: 'monthly', filename: `${dbName}_${yyyy}-${mm}.sql.gz` },
]);

// Ensure base subdirs exist once
function ensureDirs() {
  for (const setName of ['daily', 'weekly', 'monthly']) {
    fs.mkdirSync(path.join(baseDir, setName), { recursive: true });
  }
}
ensureDirs();

async function dumpAndCompress({ host, port, user, password, database }) {
  const tempSQL = path.join(baseDir, `tmp_${database}_${iso}.sql`);
  const tempGZ  = `${tempSQL}.gz`;

  // 1) Dump SQL
  await mysqldump({
    connection: { host, port, user, password, database },
    dumpToFile: tempSQL,
  });

  // 2) Compress
  await new Promise((resolve, reject) => {
    const gzip = zlib.createGzip();
    const inStream = fs.createReadStream(tempSQL);
    const outStream = fs.createWriteStream(tempGZ);
    inStream.pipe(gzip).pipe(outStream).on('finish', resolve).on('error', reject);
  });

  // Remove raw .sql to save space after gzip succeeds
  fs.unlinkSync(tempSQL);
  return tempGZ;
}

function rotateOldBackups(folder) {
  const files = fs.readdirSync(folder)
    .filter(f => f.endsWith('.sql.gz'))
    .map(f => ({ f, t: fs.statSync(path.join(folder, f)).mtime.getTime() }))
    .sort((a, b) => b.t - a.t);

  const excess = files.slice(5); // keep 5 most recent
  for (const { f } of excess) {
    fs.unlinkSync(path.join(folder, f));
    console.log(`🗑️ Deleted old backup: ${f}`);
  }
}

async function backupOneDB(cfg) {
  if (!isValid(cfg)) {
    console.log(`⚠️  Skipping ${cfg.label || 'UNKNOWN'}: missing required env (host/user/database).`);
    return;
  }

  console.log(`\n▶️  Backing up ${cfg.label} (${cfg.database}) on ${cfg.host}:${cfg.port} ...`);
  const gzPath = await dumpAndCompress(cfg);

  // Save into each retention set (filenames include db name → no conflict)
  const sets = backupSetsFor(cfg.database);
  for (const set of sets) {
    const destDir = path.join(baseDir, set.name);
    const finalPath = path.join(destDir, set.filename);
    fs.copyFileSync(gzPath, finalPath);
    console.log(`✅ Saved ${cfg.label} → ${finalPath}`);
    rotateOldBackups(destDir);
  }

  // Remove temp gzip
  fs.unlinkSync(gzPath);
}

(async () => {
  try {
    for (const cfg of dbConfigs) {
      await backupOneDB(cfg);
    }
    console.log('\n🎉 All requested backups completed.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Backup failed:', err?.stack || err?.message || err);
    process.exit(1);
  }
})();

