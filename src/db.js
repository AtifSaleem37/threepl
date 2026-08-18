const { DatabaseSync } = require('node:sqlite'); // built-in, Node >= 22.5 (no native deps)
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'invoices'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'fnsku'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'portal.db'));
try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* fs without WAL support */ }

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('admin','client','accounts','warehouse')),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  client_name TEXT,
  business_name TEXT,
  email TEXT,
  store_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Global rate card lives in settings; per-client overrides live in client_rates.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_rates (
  client_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  inbound REAL,
  fnsku REAL,
  polybag REAL,
  carton REAL,
  discount_pct REAL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES users(id),
  invoice_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  email TEXT NOT NULL,
  store_name TEXT,
  brand_name TEXT,
  asin TEXT NOT NULL,                  -- CSV of item ASINs (display)
  prep_requirement TEXT NOT NULL,      -- summary (display)
  quantity INTEGER NOT NULL,           -- total units across items
  polybag_qty INTEGER NOT NULL DEFAULT 0, -- units with poly bag & bubble wrap
  cartons INTEGER NOT NULL,
  rate_inbound REAL NOT NULL,
  rate_fnsku REAL NOT NULL,
  rate_polybag REAL NOT NULL,
  rate_carton REAL NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL,
  total REAL NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','verification','paid')),
  shipment_status TEXT NOT NULL DEFAULT 'pending',
  carrier TEXT,
  tracking_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  asin TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  polybag INTEGER NOT NULL DEFAULT 0,      -- 1 = poly bag or bubble wrap selected (billing)
  polybag_type TEXT,                        -- 'Poly bag' | 'Bubble wrap' | null
  fnsku_file TEXT,                          -- stored PDF filename, null until uploaded
  fnsku_uploaded_at TEXT,
  ship_info TEXT,                           -- shipment info entered by warehouse after prep done
  shipping_label_file TEXT,                 -- client-uploaded shipping label PDF
  shipping_label_uploaded_at TEXT
);

CREATE TABLE IF NOT EXISTS shipping_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,                       -- target portal: admin|client|accounts|warehouse
  client_id INTEGER,                        -- set when role='client'
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---- migrations (rebuild tables created before newer CHECK constraints) ----
const tableSql = name =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) || {}).sql || '';

function migrate(name, createSql) {
  // Standard SQLite table-rebuild recipe:
  // foreign_keys OFF (must be outside a transaction; node:sqlite enables FKs by default)
  // legacy_alter_table: plain rename, don't rewrite FK references in other tables
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = 1');
  try {
    db.exec(`
      BEGIN;
      DROP TABLE IF EXISTS ${name}_old;
      ALTER TABLE ${name} RENAME TO ${name}_old;
      ${createSql};
      INSERT INTO ${name} SELECT * FROM ${name}_old;
      DROP TABLE ${name}_old;
      COMMIT;
    `);
    console.log(`Migrated ${name} table`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    db.exec('PRAGMA legacy_alter_table = 0');
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// clean up any leftovers from previously interrupted migrations
db.exec('PRAGMA foreign_keys = OFF');
db.exec('DROP TABLE IF EXISTS users_old; DROP TABLE IF EXISTS orders_old;');
db.exec('PRAGMA foreign_keys = ON');

if (tableSql('users') && !tableSql('users').includes("'warehouse'")) {
  migrate('users', `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('admin','client','accounts','warehouse')),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      client_name TEXT, business_name TEXT, email TEXT, store_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
}

if (tableSql('orders') && !tableSql('orders').includes("'verification'")) {
  migrate('orders', `
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES users(id),
      invoice_no TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, business_name TEXT NOT NULL, email TEXT NOT NULL,
      store_name TEXT, asin TEXT NOT NULL,
      prep_requirement TEXT NOT NULL, quantity INTEGER NOT NULL, cartons INTEGER NOT NULL,
      rate_inbound REAL NOT NULL, rate_fnsku REAL NOT NULL,
      rate_polybag REAL NOT NULL, rate_carton REAL NOT NULL,
      discount_pct REAL NOT NULL DEFAULT 0,
      subtotal REAL NOT NULL, total REAL NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','verification','paid')),
      shipment_status TEXT NOT NULL DEFAULT 'pending',
      carrier TEXT, tracking_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
}

// additive column migrations
const hasCol = (table, col) =>
  !!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(col);
if (!hasCol('orders', 'brand_name')) db.exec('ALTER TABLE orders ADD COLUMN brand_name TEXT');
if (!hasCol('orders', 'polybag_qty')) db.exec('ALTER TABLE orders ADD COLUMN polybag_qty INTEGER NOT NULL DEFAULT 0');
if (!hasCol('order_items', 'polybag_type')) db.exec('ALTER TABLE order_items ADD COLUMN polybag_type TEXT');
if (!hasCol('order_items', 'ship_info')) db.exec('ALTER TABLE order_items ADD COLUMN ship_info TEXT');
if (!hasCol('order_items', 'shipping_label_file')) db.exec('ALTER TABLE order_items ADD COLUMN shipping_label_file TEXT');
if (!hasCol('order_items', 'shipping_label_uploaded_at')) db.exec('ALTER TABLE order_items ADD COLUMN shipping_label_uploaded_at TEXT');

// migrate legacy single shipping label per item into the multi-label table
db.exec(`
  INSERT INTO shipping_labels (item_id, file, uploaded_at)
  SELECT id, shipping_label_file, COALESCE(shipping_label_uploaded_at, datetime('now'))
  FROM order_items
  WHERE shipping_label_file IS NOT NULL
    AND id NOT IN (SELECT item_id FROM shipping_labels)`);

// repair FK reference pollution from pre-fix migrations (harmless but wrong)
if (tableSql('client_rates').includes('users_old')) {
  db.exec(`
    BEGIN;
    ALTER TABLE client_rates RENAME TO client_rates_tmp;
    CREATE TABLE client_rates (
      client_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      inbound REAL, fnsku REAL, polybag REAL, carton REAL, discount_pct REAL
    );
    INSERT INTO client_rates SELECT * FROM client_rates_tmp;
    DROP TABLE client_rates_tmp;
    COMMIT;
  `);
}

// ---- defaults ----
const DEFAULT_RATES = {
  rate_inbound: '0.20',   // per unit - Inbound Receiving & Inspection
  rate_fnsku: '0.60',     // per unit - FBA Prep / FNSKU Labeling
  rate_polybag: '0.65',   // per unit - Polybagging (only if selected)
  rate_carton: '5.00',    // per carton - Cartonization & Outbound Handling
  discount_pct: '0'
};
const setSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
for (const [k, v] of Object.entries(DEFAULT_RATES)) setSetting.run(k, v);

// Seed admin from env on first boot
const adminExists = db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get();
if (!adminExists) {
  const u = process.env.ADMIN_USERNAME || 'admin';
  const p = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO users (role,username,password_hash) VALUES (?,?,?)')
    .run('admin', u, bcrypt.hashSync(p, 10));
  console.log(`Seeded admin user "${u}"`);
}

// ---- helpers ----
function getGlobalRates() {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    inbound: parseFloat(s.rate_inbound),
    fnsku: parseFloat(s.rate_fnsku),
    polybag: parseFloat(s.rate_polybag),
    carton: parseFloat(s.rate_carton),
    discount_pct: parseFloat(s.discount_pct)
  };
}

function setGlobalRates(r) {
  const up = db.prepare('UPDATE settings SET value=? WHERE key=?');
  up.run(String(r.inbound), 'rate_inbound');
  up.run(String(r.fnsku), 'rate_fnsku');
  up.run(String(r.polybag), 'rate_polybag');
  up.run(String(r.carton), 'rate_carton');
  up.run(String(r.discount_pct), 'discount_pct');
}

// Effective rates for a client = per-client override where set, else global
function getEffectiveRates(clientId) {
  const g = getGlobalRates();
  const o = db.prepare('SELECT * FROM client_rates WHERE client_id=?').get(clientId) || {};
  const pick = (ov, gl) => (ov !== null && ov !== undefined ? ov : gl);
  return {
    inbound: pick(o.inbound, g.inbound),
    fnsku: pick(o.fnsku, g.fnsku),
    polybag: pick(o.polybag, g.polybag),
    carton: pick(o.carton, g.carton),
    discount_pct: pick(o.discount_pct, g.discount_pct)
  };
}

function nextInvoiceNo() {
  const prefix = process.env.INVOICE_PREFIX || 'INV';
  const row = db.prepare('SELECT COUNT(*) AS c FROM orders').get();
  return `${prefix}-${String(10001 + row.c)}`;
}

module.exports = { db, getGlobalRates, setGlobalRates, getEffectiveRates, nextInvoiceNo };
