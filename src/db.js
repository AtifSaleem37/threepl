const { DatabaseSync } = require('node:sqlite'); // built-in, Node >= 22.5 (no native deps)
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'invoices'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'fnsku'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'payments'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'po-photos'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'portal.db'));
try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* fs without WAL support */ }

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('admin','client','accounts','warehouse','p2p')),
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  fnsku_note TEXT,                          -- 'Listing in process' or a short free-text note instead of a PDF
  shipping_label_file TEXT,                 -- client-uploaded shipping label PDF
  shipping_label_uploaded_at TEXT
);

CREATE TABLE IF NOT EXISTS shipping_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- P2P purchase orders. Shared queue: every p2p user sees and can action all of them.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_number TEXT NOT NULL,
  store_name TEXT NOT NULL,
  brand TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'po_placed'
    CHECK (status IN ('po_placed','shipped','received','prep','partial_sent','sent_to_amazon')),
  carrier TEXT,
  tracking_id TEXT,
  pallets INTEGER,
  pallets_sent INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Line items on a PO. PO number, store and brand live on the header; ASIN,
-- product name and quantity vary per item.
CREATE TABLE IF NOT EXISTS po_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  asin TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,          -- ordered
  received_qty INTEGER,               -- counted in at Received; null until then
  sent_qty INTEGER NOT NULL DEFAULT 0 -- running total despatched to Amazon
);

-- One row per state the PO has been in, including its creation. This is the
-- audit trail shown in the portal: who moved it, when, and the photo they filed.
CREATE TABLE IF NOT EXISTS po_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  qty INTEGER,                              -- units moved by this event, for date reporting
  photo TEXT,
  detail TEXT,
  user_id INTEGER REFERENCES users(id),
  user_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
db.exec('DROP TABLE IF EXISTS users_old; DROP TABLE IF EXISTS orders_old; DROP TABLE IF EXISTS purchase_orders_old;');
db.exec('PRAGMA foreign_keys = ON');

if (tableSql('users') && !tableSql('users').includes("'warehouse'")) {
  migrate('users', `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('admin','client','accounts','warehouse','p2p')),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      client_name TEXT, business_name TEXT, email TEXT, store_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
}

if (tableSql('users') && !tableSql('users').includes("'p2p'")) {
  migrate('users', `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('admin','client','accounts','warehouse','p2p')),
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
if (!hasCol('order_items', 'fnsku_note')) db.exec('ALTER TABLE order_items ADD COLUMN fnsku_note TEXT');
if (!hasCol('order_items', 'shipping_label_file')) db.exec('ALTER TABLE order_items ADD COLUMN shipping_label_file TEXT');
if (!hasCol('order_items', 'shipping_label_uploaded_at')) db.exec('ALTER TABLE order_items ADD COLUMN shipping_label_uploaded_at TEXT');
// proof-of-payment screenshot the client attaches when marking payment sent
if (!hasCol('orders', 'payment_proof')) db.exec('ALTER TABLE orders ADD COLUMN payment_proof TEXT');
if (!hasCol('orders', 'payment_proof_uploaded_at')) db.exec('ALTER TABLE orders ADD COLUMN payment_proof_uploaded_at TEXT');
// --- POs become header + line items, and rows sharing a PO number are merged ---
// Old shape carried one ASIN per row, so the same PO number appeared several
// times. Items move to po_items; duplicates collapse onto the earliest row.
if (hasCol('purchase_orders', 'asin')) {
  const RANK = { po_placed: 0, shipped: 1, received: 2, prep: 3, partial_sent: 4, sent_to_amazon: 5 };
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = 1');
  try {
    db.exec('BEGIN');

    // 1. every existing row contributes its single ASIN as a line item
    db.exec(`INSERT INTO po_items (po_id, asin, product_name, quantity)
             SELECT id, asin, product_name, quantity FROM purchase_orders`);

    // 2. collapse rows sharing a PO number onto the earliest of them
    const rows = db.prepare('SELECT * FROM purchase_orders ORDER BY id').all();
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.po_number)) groups.set(r.po_number, []);
      groups.get(r.po_number).push(r);
    }
    let mergedPos = 0, removedRows = 0;
    for (const [poNumber, grp] of groups) {
      if (grp.length < 2) continue;
      const keep = grp[0];
      // furthest-advanced row decides status and carries the tracking details
      const lead = grp.reduce((a, b) => (RANK[b.status] ?? 0) > (RANK[a.status] ?? 0) ? b : a, grp[0]);
      const pallets = grp.reduce((n, r) => n + (r.pallets || 0), 0);
      const palletsSent = grp.reduce((n, r) => n + (r.pallets_sent || 0), 0);
      for (const r of grp.slice(1)) {
        db.prepare('UPDATE po_items SET po_id=? WHERE po_id=?').run(keep.id, r.id);
        db.prepare('UPDATE po_events SET po_id=? WHERE po_id=?').run(keep.id, r.id);
        db.prepare('DELETE FROM purchase_orders WHERE id=?').run(r.id);
        removedRows++;
      }
      db.prepare(`UPDATE purchase_orders
                  SET status=?, carrier=?, tracking_id=?, pallets=?, pallets_sent=?,
                      updated_at=?
                  WHERE id=?`)
        .run(lead.status, lead.carrier, lead.tracking_id,
             pallets || null, palletsSent,
             grp.reduce((a, r) => (r.updated_at > a ? r.updated_at : a), keep.updated_at),
             keep.id);
      mergedPos++;
      console.log(`  merged ${grp.length} rows sharing PO ${poNumber} -> status ${lead.status}`);
    }

    // 3. drop the per-item columns from the header
    const COLS = `id, po_number, store_name, brand, status, carrier, tracking_id,
                  pallets, pallets_sent, created_by, created_by_name, created_at, updated_at`;
    db.exec(`
      DROP TABLE IF EXISTS purchase_orders_old;
      ALTER TABLE purchase_orders RENAME TO purchase_orders_old;
      CREATE TABLE purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_number TEXT NOT NULL,
        store_name TEXT NOT NULL,
        brand TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'po_placed'
          CHECK (status IN ('po_placed','shipped','received','prep','partial_sent','sent_to_amazon')),
        carrier TEXT,
        tracking_id TEXT,
        pallets INTEGER,
        pallets_sent INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO purchase_orders (${COLS}) SELECT ${COLS} FROM purchase_orders_old;
      DROP TABLE purchase_orders_old;
    `);
    db.exec('COMMIT');
    console.log(`Migrated purchase_orders to header + line items` +
      (mergedPos ? ` (${mergedPos} PO number(s) merged, ${removedRows} duplicate row(s) folded in)` : ''));
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    db.exec('PRAGMA legacy_alter_table = 0');
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Units moved by each event, so received/sent can be reported over a date range.
if (!hasCol('po_events', 'qty')) {
  db.exec('ALTER TABLE po_events ADD COLUMN qty INTEGER');
  // Backfill what can be attributed unambiguously: a PO's receipt total, and a
  // despatch total where the PO has only one despatch event. POs despatched in
  // several goes predate the per-event figure and stay null rather than guessed.
  db.exec(`UPDATE po_events SET qty = (
             SELECT COALESCE(SUM(COALESCE(i.received_qty, i.quantity)), 0)
             FROM po_items i WHERE i.po_id = po_events.po_id)
           WHERE status = 'received' AND qty IS NULL`);
  db.exec(`UPDATE po_events SET qty = (
             SELECT COALESCE(SUM(i.sent_qty), 0) FROM po_items i WHERE i.po_id = po_events.po_id)
           WHERE status IN ('partial_sent','sent_to_amazon') AND qty IS NULL
             AND (SELECT COUNT(*) FROM po_events e2
                  WHERE e2.po_id = po_events.po_id
                    AND e2.status IN ('partial_sent','sent_to_amazon')) = 1`);
}

// Per-ASIN counts: what actually arrived, and what has gone out so far.
if (!hasCol('po_items', 'received_qty')) db.exec('ALTER TABLE po_items ADD COLUMN received_qty INTEGER');
if (!hasCol('po_items', 'sent_qty')) db.exec('ALTER TABLE po_items ADD COLUMN sent_qty INTEGER NOT NULL DEFAULT 0');
// POs already past Received predate the count, so assume the ordered quantity
// arrived; otherwise they would read as nothing received at all.
db.exec(`UPDATE po_items SET received_qty = quantity
         WHERE received_qty IS NULL AND po_id IN (
           SELECT id FROM purchase_orders
           WHERE status IN ('received','prep','partial_sent','sent_to_amazon'))`);

// Running total of pallets already despatched to Amazon, for partial sends.
if (!hasCol('purchase_orders', 'pallets_sent')) {
  db.exec('ALTER TABLE purchase_orders ADD COLUMN pallets_sent INTEGER NOT NULL DEFAULT 0');
}
// Widening a CHECK needs a table rebuild. ALTER appended pallets_sent at the end,
// so the column list below is explicit rather than SELECT * - the two orders differ.
if (tableSql('purchase_orders') && !tableSql('purchase_orders').includes("'partial_sent'")) {
  const COLS = `id, po_number, store_name, brand, asin, product_name, quantity, status,
                carrier, tracking_id, pallets, created_by, created_by_name,
                created_at, updated_at, pallets_sent`;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = 1');
  try {
    db.exec(`
      BEGIN;
      DROP TABLE IF EXISTS purchase_orders_old;
      ALTER TABLE purchase_orders RENAME TO purchase_orders_old;
      CREATE TABLE purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_number TEXT NOT NULL,
        store_name TEXT NOT NULL,
        brand TEXT NOT NULL,
        asin TEXT NOT NULL,
        product_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'po_placed'
          CHECK (status IN ('po_placed','shipped','received','prep','partial_sent','sent_to_amazon')),
        carrier TEXT,
        tracking_id TEXT,
        pallets INTEGER,
        created_by INTEGER REFERENCES users(id),
        created_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        pallets_sent INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO purchase_orders (${COLS}) SELECT ${COLS} FROM purchase_orders_old;
      DROP TABLE purchase_orders_old;
      COMMIT;
    `);
    console.log('Migrated purchase_orders table');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  } finally {
    db.exec('PRAGMA legacy_alter_table = 0');
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// last-activity timestamp; SQLite rejects a non-constant DEFAULT in ALTER TABLE,
// so add it nullable and backfill existing rows from created_at.
if (!hasCol('orders', 'updated_at')) {
  db.exec('ALTER TABLE orders ADD COLUMN updated_at TEXT');
  db.exec('UPDATE orders SET updated_at = created_at WHERE updated_at IS NULL');
}

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
  // Volume discount, picked by total units on the order. Percentages are
  // admin-editable; the quantity bands themselves are fixed.
  discount_t1: '5',       // 0 - 500 units
  discount_t2: '10',      // 501 - 1000 units
  discount_t3: '15',      // 1001 - 1500 units
  discount_t4: '20'       // 1501+ units
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
    carton: parseFloat(s.rate_carton)
  };
}

function setGlobalRates(r) {
  const up = db.prepare('UPDATE settings SET value=? WHERE key=?');
  up.run(String(r.inbound), 'rate_inbound');
  up.run(String(r.fnsku), 'rate_fnsku');
  up.run(String(r.polybag), 'rate_polybag');
  up.run(String(r.carton), 'rate_carton');
}

// ---- volume discount ----
// Bands are fixed; only the percentages are editable from the admin portal.
const DISCOUNT_TIERS = [
  { key: 'discount_t1', min: 0, max: 500, label: '0 - 500 units' },
  { key: 'discount_t2', min: 501, max: 1000, label: '501 - 1,000 units' },
  { key: 'discount_t3', min: 1001, max: 1500, label: '1,001 - 1,500 units' },
  { key: 'discount_t4', min: 1501, max: Infinity, label: '1,501 units and above' }
];

function getDiscountTiers() {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return DISCOUNT_TIERS.map(t => ({ ...t, pct: parseFloat(s[t.key]) || 0 }));
}

function setDiscountTiers(pcts) {
  const up = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
                         ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  DISCOUNT_TIERS.forEach((t, i) => up.run(t.key, String(pcts[i])));
}

// Which band a quantity falls into. Quantities below the first band (only
// possible for malformed data) fall back to the lowest tier.
function tierForQuantity(qty) {
  const tiers = getDiscountTiers();
  return tiers.find(t => qty >= t.min && qty <= t.max) || tiers[0];
}

// Effective rates for a client = per-client override where set, else global.
// The discount is NOT overridable - total units always decide it.
function getEffectiveRates(clientId, quantity = 0) {
  const g = getGlobalRates();
  const o = db.prepare('SELECT * FROM client_rates WHERE client_id=?').get(clientId) || {};
  const pick = (ov, gl) => (ov !== null && ov !== undefined ? ov : gl);
  return {
    inbound: pick(o.inbound, g.inbound),
    fnsku: pick(o.fnsku, g.fnsku),
    polybag: pick(o.polybag, g.polybag),
    carton: pick(o.carton, g.carton),
    discount_pct: tierForQuantity(quantity).pct
  };
}

function nextInvoiceNo() {
  const prefix = process.env.INVOICE_PREFIX || 'INV';
  const row = db.prepare('SELECT COUNT(*) AS c FROM orders').get();
  return `${prefix}-${String(10001 + row.c)}`;
}

module.exports = {
  db, getGlobalRates, setGlobalRates, getEffectiveRates, nextInvoiceNo,
  DISCOUNT_TIERS, getDiscountTiers, setDiscountTiers, tierForQuantity
};
