require('./env');
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const multer = require('multer');
const { db, getGlobalRates, setGlobalRates, getEffectiveRates, nextInvoiceNo,
        getDiscountTiers, setDiscountTiers } = require('./db');
const { generateInvoicePdf, buildLineItems, INVOICE_DIR } = require('./invoice');
const { sendInvoiceEmail, sendEventEmail } = require('./mailer');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FNSKU_DIR = path.join(DATA_DIR, 'fnsku');
const SHIPLABEL_DIR = path.join(DATA_DIR, 'shiplabels');
const PAYMENT_DIR = path.join(DATA_DIR, 'payments');
const PO_PHOTO_DIR = path.join(DATA_DIR, 'po-photos');
fs.mkdirSync(SHIPLABEL_DIR, { recursive: true });
fs.mkdirSync(PAYMENT_DIR, { recursive: true });
fs.mkdirSync(PO_PHOTO_DIR, { recursive: true });
const fnskuUpload = multer({
  storage: multer.diskStorage({
    destination: FNSKU_DIR,
    filename: (req, file, cb) => cb(null, `tmp-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' && /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error('Only PDF files are accepted for FNSKU labels'), ok);
  }
});
// Proof-of-payment screenshot attached when the client marks payment sent.
const PROOF_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
const proofUpload = multer({
  storage: multer.diskStorage({
    destination: PAYMENT_DIR,
    filename: (req, file, cb) => cb(null, `tmp-${Date.now()}-${Math.round(Math.random() * 1e9)}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = !!PROOF_TYPES[file.mimetype] &&
      /\.(jpe?g|png|webp|pdf)$/i.test(file.originalname);
    cb(ok ? null : new Error('Payment proof must be a JPG, PNG, WEBP or PDF file'), ok);
  }
});
// Photo filed with every P2P status change.
const PHOTO_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic' };
const poPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: PO_PHOTO_DIR,
    filename: (req, file, cb) => cb(null, `tmp-${Date.now()}-${Math.round(Math.random() * 1e9)}`)
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = !!PHOTO_TYPES[file.mimetype] && /\.(jpe?g|png|webp|heic)$/i.test(file.originalname);
    cb(ok ? null : new Error('Photo must be a JPG, PNG, WEBP or HEIC image'), ok);
  }
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(cookieSession({
  name: 'threepl',
  secret: process.env.SESSION_SECRET || 'dev-secret',
  maxAge: 12 * 60 * 60 * 1000,
  sameSite: 'lax'
}));

// ---- auth helpers ----
const CLIENT_SHIP_STATUSES = ['pending', 'shipped'];   // client marks shipment to warehouse; warehouse marks received
const PAY_LABELS = { unpaid: 'Unpaid', verification: 'Verification in progress', paid: 'Paid' };
const SHIP_LABELS = {
  pending: 'Pending', shipped: 'Shipped', received: 'Received',
  prep: 'Prep in progress', prep_done: 'Prep done', sent_to_amazon: 'Sent to Amazon'
};
// items missing at least one shipping label for an order
const missingSlabelsSql = `
  (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id
     AND NOT EXISTS (SELECT 1 FROM shipping_labels l WHERE l.item_id = i.id))`;

// Free-text search over client name + brand name, as an appendable AND clause.
// Always parameterised; % and _ in the term are escaped so they match literally.
// `withAccount` adds the joined users.client_name (admin and accounts only).
function searchFilter(q, withAccount = false) {
  const term = (q || '').trim();
  if (!term) return { clause: '', params: [] };
  const like = '%' + term.replace(/[\\%_]/g, c => '\\' + c) + '%';
  const cols = ['o.name', 'o.brand_name'];
  if (withAccount) cols.push('u.client_name');
  return {
    clause: ` AND (${cols.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    params: cols.map(() => like)
  };
}

// ---- notifications (keep only the last 5 per audience) ----
function notify(role, message, clientId = null) {
  db.prepare('INSERT INTO notifications (role, client_id, message) VALUES (?,?,?)').run(role, clientId, message);
  db.prepare(`DELETE FROM notifications WHERE role=? AND client_id IS ? AND id NOT IN (
    SELECT id FROM notifications WHERE role=? AND client_id IS ? ORDER BY id DESC LIMIT 5)`)
    .run(role, clientId, role, clientId);
}
// Every portal lists orders by most-recent activity. COALESCE guards rows from
// before updated_at existed, in case any escaped the backfill.
const RECENT_FIRST = 'ORDER BY COALESCE(o.updated_at, o.created_at) DESC, o.id DESC';
// Bump an order's last-activity stamp for changes that live in a child table
// (labels, shipment info); direct UPDATEs on orders set updated_at inline.
const touchOrder = id => db.prepare("UPDATE orders SET updated_at=datetime('now') WHERE id=?").run(id);

// Order-lifecycle actions are emailed to the operations mailbox; 'tracking' and
// 'payment' copy their own recipients too (see mailer.js). Fire-and-forget by
// design: a mail failure is logged and never blocks the action that caused it.
function emailEvent(order, subject, detail = '', audiences = []) {
  if (!order) return;
  sendEventEmail({ order, subject, detail, audiences })
    .catch(e => console.error(`[mailer] "${subject}" for ${order.invoice_no} failed:`, e.message));
}

const getNotifs = (role, clientId = null) =>
  db.prepare('SELECT * FROM notifications WHERE role=? AND client_id IS ? ORDER BY id DESC LIMIT 5')
    .all(role, clientId);
const HOME = { admin: '/admin', client: '/clients', accounts: '/accounts', warehouse: '/warehouse', p2p: '/p2p' };
// `tagline` sits under the wordmark on the login card. P2P handles purchase
// orders rather than prep, so it carries no tagline.
const PORTALS = {
  admin: { key: 'admin', path: '/admin', label: 'Admin', tagline: '3PL Prep Portal' },
  client: { key: 'client', path: '/clients', label: 'Client', tagline: '3PL Prep Portal' },
  accounts: { key: 'accounts', path: '/accounts', label: 'Accounts', tagline: '3PL Prep Portal' },
  warehouse: { key: 'warehouse', path: '/warehouse', label: 'Warehouse', tagline: '3PL Prep Portal' },
  p2p: { key: 'p2p', path: '/p2p', label: 'P2P', tagline: '' }
};

// ---- P2P purchase orders ----
const PO_LABELS = {
  po_placed: 'PO placed', shipped: 'Shipped', received: 'Received',
  prep: 'Prep in progress', partial_sent: 'Partially sent to Amazon',
  sent_to_amazon: 'Sent to Amazon'
};
// Linear pipeline. partial_sent loops back on itself: despatching is repeatable
// until the running total reaches the pallet count, which closes the PO.
const PO_NEXT = {
  po_placed: 'shipped', shipped: 'received', received: 'prep',
  prep: 'sent_to_amazon', partial_sent: 'sent_to_amazon'
};
// Password policy: at least 8 characters, containing both letters and digits.
// Returns the reason it fails, or null when acceptable.
function passwordProblem(pw) {
  const str = String(pw == null ? '' : pw);
  if (str.length < 8) return 'Password must be at least 8 characters long';
  if (!/[A-Za-z]/.test(str)) return 'Password must contain at least one letter';
  if (!/[0-9]/.test(str)) return 'Password must contain at least one number';
  return null;
}

// Strict whole-number parse for pallet counts. parseInt is unusable here: it
// silently truncates "3.7" to 3, reads "1e3" as 1 and "5abc" as 5. Leading zeros
// and surrounding whitespace are fine; signs, decimals and trailing text are not.
function wholeNumber(v) {
  const str = String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(str)) return null;
  const n = Number(str);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Pallets the warehouse can hold. Advisory: occupancy is reported, never enforced.
const WAREHOUSE_CAPACITY = parseInt(process.env.WAREHOUSE_CAPACITY || '50', 10);

// Occupancy snapshot for the Warehouse Status tab.
//   on the floor = pallets received but not yet despatched
//   in transit   = pallets on POs marked shipped but not yet received
function warehouseStatus() {
  const onFloor = db.prepare(`
    SELECT COALESCE(SUM(MAX(COALESCE(pallets,0) - pallets_sent, 0)), 0) AS n,
           COUNT(*) AS pos
    FROM purchase_orders WHERE status IN ('received','prep','partial_sent')`).get();
  const transit = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(pallets,0)), 0) AS n, COUNT(*) AS pos
    FROM purchase_orders WHERE status='shipped'`).get();

  const inWarehouse = onFloor.n, inTransit = transit.n;
  const committed = inWarehouse + inTransit;
  const free = Math.max(0, WAREHOUSE_CAPACITY - committed);
  // Over capacity, the ring shows the share of what is committed rather than of 50.
  const total = Math.max(WAREHOUSE_CAPACITY, committed) || 1;

  const segments = [
    { key: 'warehouse', label: 'In warehouse', value: inWarehouse, color: '#2a78d6' },
    { key: 'transit', label: 'In transit', value: inTransit, color: '#eb6834' },
    { key: 'free', label: 'Free space', value: free, color: '#e4e9f2' }
  ];
  // Ring geometry is computed here so the template stays declarative.
  const R = 70, C = 2 * Math.PI * R;
  const drawn = segments.filter(s => s.value > 0);
  const GAP = drawn.length > 1 ? 3 : 0;
  let acc = 0;
  const arcs = drawn.map(seg => {
    const frac = seg.value / total;
    const len = Math.max(0, frac * C - GAP);
    const arc = { ...seg, len, rest: C - len, offset: -acc * C, pct: Math.round(frac * 100) };
    acc += frac;
    return arc;
  });

  return {
    capacity: WAREHOUSE_CAPACITY, inWarehouse, inTransit, committed, free, total,
    posOnFloor: onFloor.pos, posInTransit: transit.pos,
    segments, arcs, radius: R, circumference: C,
    over: Math.max(0, inWarehouse - WAREHOUSE_CAPACITY),
    overCommitted: Math.max(0, committed - WAREHOUSE_CAPACITY)
  };
}
// A photo is only demanded on arrival at the warehouse and on despatch to
// Amazon. The two steps in between take one if offered but do not require it.
const PO_PHOTO_REQUIRED = ['received', 'sent_to_amazon'];   // partial sends included - they advance via 'sent_to_amazon'
// "PO placed by Ahmed" - first name only, as asked.
const firstNameOf = u => String(u.client_name || u.username || '').trim().split(/\s+/)[0] || u.username;

// Each role has its own session slot (req.session.admin / .client / .accounts),
// so different portals can be logged in simultaneously in the same browser.
const requireRole = role => (req, res, next) =>
  req.session[role] ? next() : res.redirect(PORTALS[role].path);
const requireAdmin = requireRole('admin');
const requireClient = requireRole('client');
const requireAccounts = requireRole('accounts');
const requireWarehouse = requireRole('warehouse');
const requireP2p = requireRole('p2p');

const renderLogin = (res, role, error, status) =>
  res.status(status || 200).render('login', { portal: PORTALS[role], error: error || null });

// Role-specific login handler: /admin/login, /clients/login, /accounts/login
const loginHandler = role => (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username=?').get((username || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return renderLogin(res, role, 'Invalid username or password', 401);
  }
  if (user.role !== role) {
    return renderLogin(res, role, `This account is not a${role === 'admin' || role === 'accounts' ? 'n' : ''} ${PORTALS[role].label.toLowerCase()} account`, 403);
  }
  req.session[role] = { id: user.id, role: user.role, username: user.username, client_name: user.client_name };
  res.redirect(PORTALS[role].path);
};

// ---- auth ----
app.post('/admin/login', loginHandler('admin'));
app.post('/clients/login', loginHandler('client'));
app.post('/accounts/login', loginHandler('accounts'));
app.post('/warehouse/login', loginHandler('warehouse'));
app.post('/p2p/login', loginHandler('p2p'));

// Per-portal logout: only clears that role's session
for (const [role, p] of Object.entries(PORTALS)) {
  app.post(`${p.path}/logout`, (req, res) => {
    if (req.session) req.session[role] = null;
    res.redirect(p.path);
  });
}
app.post('/logout', (req, res) => { req.session = null; res.redirect('/clients'); });

app.get('/', (req, res) => {
  const s = req.session || {};
  res.redirect(s.admin ? '/admin' : s.accounts ? '/accounts' : '/clients');
});
app.get('/login', (req, res) => res.redirect('/clients'));
app.get('/client', (req, res) => res.redirect('/clients')); // old URL

// ---- admin ----
app.get('/admin', (req, res, next) => {
  if (!req.session.admin) return renderLogin(res, 'admin');
  next();
}, (req, res) => {
  const q = (req.query.q || '').trim();
  const f = searchFilter(q, true);
  const orders = db.prepare(`
    SELECT o.*, u.client_name AS account_name
    FROM orders o JOIN users u ON u.id = o.client_id
    WHERE 1=1${f.clause}
    ${RECENT_FIRST}`).all(...f.params);
  const clients = db.prepare(`
    SELECT u.*, r.inbound AS o_inbound, r.fnsku AS o_fnsku, r.polybag AS o_polybag,
           r.carton AS o_carton, r.discount_pct AS o_discount
    FROM users u LEFT JOIN client_rates r ON r.client_id = u.id
    WHERE u.role='client' ORDER BY u.client_name`).all();
  const staffUsers = db.prepare("SELECT * FROM users WHERE role IN ('accounts','warehouse','p2p') ORDER BY role, username").all();
  const TABS = ['orders', 'client-user', 'staff', 'clients', 'account'];
  res.render('admin', {
    user: req.session.admin,
    orders, clients, staffUsers, q,
    rates: getGlobalRates(),
    discountTiers: getDiscountTiers(),
    payLabels: PAY_LABELS,
    shipLabels: SHIP_LABELS,
    notifs: getNotifs('admin'),
    tab: TABS.includes(req.query.tab) ? req.query.tab : 'orders',
    msg: req.query.msg || null,
    err: req.query.err || null
  });
});

// Create client, accounts, or warehouse user
app.post('/admin/clients', requireAdmin, (req, res) => {
  const { client_name, business_name, email, store_name, username, password } = req.body;
  const role = ['accounts', 'warehouse', 'p2p'].includes(req.body.role) ? req.body.role : 'client';
  const tab = role === 'client' ? 'client-user' : 'staff';
  if (!username || !password || !client_name) {
    return res.redirect(`/admin?tab=${tab}&err=Missing required fields`);
  }
  try {
    db.prepare(`INSERT INTO users (role,username,password_hash,client_name,business_name,email,store_name)
                VALUES (?,?,?,?,?,?,?)`)
      .run(role, username.trim(), bcrypt.hashSync(password, 10), client_name.trim(),
           business_name || null, email || null, store_name || null);
    const LABELS = { client: 'Client', accounts: 'Accounts user', warehouse: 'Warehouse user', p2p: 'P2P user' };
    const label = LABELS[role];
    res.redirect(`/admin?tab=${tab}&msg=` + encodeURIComponent(`${label} "${username.trim()}" created`));
  } catch (e) {
    const reason = e.message.includes('UNIQUE') ? 'Username already exists' : `Failed to create user: ${e.message}`;
    res.redirect(`/admin?tab=${tab}&err=` + encodeURIComponent(reason));
  }
});

// Reset a user's password (client, accounts, or warehouse)
app.post('/admin/clients/:id/password', requireAdmin, (req, res) => {
  const tab = req.query.tab === 'staff' ? 'staff' : 'clients';
  if (!req.body.password) return res.redirect(`/admin?tab=${tab}&err=Password required`);
  db.prepare("UPDATE users SET password_hash=? WHERE id=? AND role IN ('client','accounts','warehouse','p2p')")
    .run(bcrypt.hashSync(req.body.password, 10), req.params.id);
  res.redirect(`/admin?tab=${tab}&msg=Password updated`);
});

// Admin changes their own password. The current password is required, so a
// hijacked session alone cannot lock the real admin out.
app.post('/admin/password', requireAdmin, (req, res) => {
  const back = '/admin?tab=account&';
  const { current_password, new_password, confirm_password } = req.body;
  const me = db.prepare("SELECT * FROM users WHERE id=? AND role='admin'").get(req.session.admin.id);
  if (!me || !bcrypt.compareSync(current_password || '', me.password_hash)) {
    return res.redirect(back + 'err=' + encodeURIComponent('Current password is incorrect'));
  }
  const problem = passwordProblem(new_password);
  if (problem) return res.redirect(back + 'err=' + encodeURIComponent(problem));
  if (new_password !== confirm_password) {
    return res.redirect(back + 'err=' + encodeURIComponent('New password and confirmation do not match'));
  }
  if (bcrypt.compareSync(new_password, me.password_hash)) {
    return res.redirect(back + 'err=' + encodeURIComponent('New password must be different from the current one'));
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(new_password, 10), me.id);
  console.log(`[admin] password changed for "${me.username}"`);
  res.redirect(back + 'msg=' + encodeURIComponent('Password updated'));
});

// Global rates
app.post('/admin/rates', requireAdmin, (req, res) => {
  const { inbound, fnsku, polybag, carton } = req.body;
  setGlobalRates({
    inbound: parseFloat(inbound) || 0,
    fnsku: parseFloat(fnsku) || 0,
    polybag: parseFloat(polybag) || 0,
    carton: parseFloat(carton) || 0
  });
  res.redirect('/admin?tab=clients&msg=Global rates updated');
});

// Volume discount percentages (quantity bands are fixed in db.js)
app.post('/admin/discount-tiers', requireAdmin, (req, res) => {
  const pcts = ['t1', 't2', 't3', 't4'].map(k => {
    const n = parseFloat(req.body[k]);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
  });
  setDiscountTiers(pcts);
  res.redirect('/admin?tab=clients&msg=' + encodeURIComponent('Discount tiers updated'));
});

// Per-client rate overrides (blank field = use global)
app.post('/admin/clients/:id/rates', requireAdmin, (req, res) => {
  const num = v => (v === '' || v === undefined ? null : parseFloat(v));
  // discount_pct is intentionally NULL: volume tiers decide the discount now.
  db.prepare(`INSERT INTO client_rates (client_id,inbound,fnsku,polybag,carton,discount_pct)
              VALUES (?,?,?,?,?,NULL)
              ON CONFLICT(client_id) DO UPDATE SET
                inbound=excluded.inbound, fnsku=excluded.fnsku, polybag=excluded.polybag,
                carton=excluded.carton, discount_pct=NULL`)
    .run(req.params.id, num(req.body.inbound), num(req.body.fnsku),
         num(req.body.polybag), num(req.body.carton));
  res.redirect('/admin?tab=clients&msg=Client rates updated');
});

// ---- warehouse ----
const WH_STATUSES = "('shipped','received','prep','prep_done','sent_to_amazon')";
app.get('/warehouse', (req, res, next) => {
  if (!req.session.warehouse) return renderLogin(res, 'warehouse');
  next();
}, (req, res) => {
  const q = (req.query.q || '').trim();
  const f = searchFilter(q);
  const orders = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id AND i.ship_info IS NULL) AS missing_info,
      ${missingSlabelsSql} AS missing_slabels
    FROM orders o
    WHERE o.shipment_status IN ${WH_STATUSES}${f.clause}
    ${RECENT_FIRST}`).all(...f.params);
  const itemsByOrder = {}, labelsByItem = {};
  for (const it of db.prepare(`
    SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.shipment_status IN ${WH_STATUSES}`).all()) {
    (itemsByOrder[it.order_id] = itemsByOrder[it.order_id] || []).push(it);
  }
  for (const l of db.prepare(`
    SELECT l.* FROM shipping_labels l
    JOIN order_items i ON i.id = l.item_id JOIN orders o ON o.id = i.order_id
    WHERE o.shipment_status IN ${WH_STATUSES} ORDER BY l.id`).all()) {
    (labelsByItem[l.item_id] = labelsByItem[l.item_id] || []).push(l);
  }
  res.render('warehouse', {
    user: req.session.warehouse, orders, itemsByOrder, labelsByItem, q,
    payLabels: PAY_LABELS,
    shipLabels: SHIP_LABELS,
    notifs: getNotifs('warehouse'),
    tab: req.query.tab === 'notifications' ? 'notifications' : 'shipments',
    msg: req.query.msg || null,
    err: req.query.err || null
  });
});

// Warehouse status transitions: shipped -> received -> prep -> prep_done
function whTransition(from, to, doneMsg) {
  return (req, res) => {
    const order = db.prepare(`SELECT * FROM orders WHERE id=? AND shipment_status=?`).get(req.params.id, from);
    if (!order) return res.redirect('/warehouse?err=' + encodeURIComponent(`Order is not in "${SHIP_LABELS[from]}" state`));
    db.prepare("UPDATE orders SET shipment_status=?, updated_at=datetime('now') WHERE id=?").run(to, order.id);
    notify('client', `${order.invoice_no}: ${doneMsg}`, order.client_id);
    if (to === 'received') notify('admin', `${order.invoice_no}: received by warehouse`);
    emailEvent({ ...order, shipment_status: to }, `Warehouse: ${SHIP_LABELS[to]}`,
      `Warehouse moved this order from "${SHIP_LABELS[from]}" to "${SHIP_LABELS[to]}".`);
    res.redirect('/warehouse?msg=' + encodeURIComponent(`Order ${order.invoice_no} - ${SHIP_LABELS[to]}`));
  };
}
app.post('/warehouse/orders/:id/received', requireWarehouse, whTransition('shipped', 'received', 'shipment received by warehouse'));
app.post('/warehouse/orders/:id/prep', requireWarehouse, whTransition('received', 'prep', 'prep in progress'));
app.post('/warehouse/orders/:id/prep-done', requireWarehouse, whTransition('prep', 'prep_done', 'prep done - shipment info will follow'));

// Warehouse marks order sent to Amazon (requires all ship info + at least one shipping label per ASIN)
app.post('/warehouse/orders/:id/sent-to-amazon', requireWarehouse, (req, res) => {
  const order = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id AND i.ship_info IS NULL) AS missing_info,
      ${missingSlabelsSql} AS missing_slabels
    FROM orders o WHERE o.id=? AND o.shipment_status='prep_done'`).get(req.params.id);
  if (!order) return res.redirect('/warehouse?err=' + encodeURIComponent('Order is not in "Prep done" state'));
  if (order.missing_info > 0 || order.missing_slabels > 0) {
    return res.redirect('/warehouse?err=' + encodeURIComponent('Every ASIN needs shipment info and at least one shipping label first'));
  }
  db.prepare("UPDATE orders SET shipment_status='sent_to_amazon', updated_at=datetime('now') WHERE id=?").run(order.id);
  notify('client', `${order.invoice_no}: shipment sent to Amazon`, order.client_id);
  notify('admin', `${order.invoice_no}: sent to Amazon by warehouse`);
  emailEvent(order, 'Shipment sent to Amazon',
    'Warehouse marked this order sent to Amazon. All ASINs had shipment info and at least one shipping label.');
  res.redirect('/warehouse?msg=' + encodeURIComponent(`Order ${order.invoice_no} - Sent to Amazon`));
});

// Warehouse enters shipment info per ASIN (after prep done)
app.post('/warehouse/orders/:id/ship-info', requireWarehouse, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND shipment_status='prep_done'").get(req.params.id);
  if (!order) return res.redirect('/warehouse?err=' + encodeURIComponent('Order is not in "Prep done" state'));
  let saved = 0;
  for (const [key, val] of Object.entries(req.body)) {
    const m = key.match(/^info_(\d+)$/);
    if (!m || !String(val).trim()) continue;
    const r = db.prepare('UPDATE order_items SET ship_info=? WHERE id=? AND order_id=?')
      .run(String(val).trim(), m[1], order.id);
    saved += r.changes;
  }
  if (!saved) return res.redirect('/warehouse?err=' + encodeURIComponent('No shipment info entered'));
  touchOrder(order.id);
  const missing = db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id=? AND ship_info IS NULL').get(order.id).c;
  if (missing === 0) {
    notify('client', `${order.invoice_no}: shipment info added - please upload shipping labels for each ASIN`, order.client_id);
  }
  emailEvent(order, 'Warehouse added shipment info',
    `Shipment info saved for ${saved} ASIN(s).` +
    (missing ? ` ${missing} ASIN(s) still missing info.` : ' All ASINs now have info; client asked to upload shipping labels.'));
  res.redirect('/warehouse?msg=' + encodeURIComponent(
    missing ? `Shipment info saved - ${missing} ASIN(s) still missing info` : 'Shipment info saved for all ASINs - client notified'));
});

// ---- P2P (purchase orders) ----
// Search spans every field on the PO, since a buyer may look up any of them.
function poSearchFilter(q) {
  const term = (q || '').trim();
  if (!term) return { clause: '', params: [] };
  const like = '%' + term.replace(/[\\%_]/g, c => '\\' + c) + '%';
  const cols = ['po_number', 'store_name', 'brand', 'asin', 'product_name'];
  return {
    clause: ` AND (${cols.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    params: cols.map(() => like)
  };
}

app.get('/p2p', (req, res, next) => {
  if (!req.session.p2p) return renderLogin(res, 'p2p');
  next();
}, (req, res) => {
  const q = (req.query.q || '').trim();
  const f = poSearchFilter(q);
  const pos = db.prepare(`
    SELECT * FROM purchase_orders
    WHERE 1=1${f.clause}
    ORDER BY COALESCE(updated_at, created_at) DESC, id DESC`).all(...f.params);
  const eventsByPo = {};
  for (const e of db.prepare('SELECT * FROM po_events ORDER BY id').all()) {
    (eventsByPo[e.po_id] = eventsByPo[e.po_id] || []).push(e);
  }
  res.render('p2p', {
    user: req.session.p2p, pos, eventsByPo, q,
    poLabels: PO_LABELS, poNext: PO_NEXT, poPhotoRequired: PO_PHOTO_REQUIRED,
    wh: warehouseStatus(),
    notifs: getNotifs('p2p'),
    tab: req.query.tab === 'warehouse' ? 'warehouse' : 'orders',
    openNew: req.query.new === '1',
    msg: req.query.msg || null,
    err: req.query.err || null
  });
});

// Create a PO. All six fields are mandatory; no photo at this stage.
app.post('/p2p/pos', requireP2p, (req, res) => {
  const back = '/p2p?new=1&err=';
  const f = {
    po_number: (req.body.po_number || '').trim(),
    store_name: (req.body.store_name || '').trim(),
    brand: (req.body.brand || '').trim(),
    asin: (req.body.asin || '').trim(),
    product_name: (req.body.product_name || '').trim()
  };
  const quantity = parseInt(req.body.quantity, 10);
  if (Object.values(f).some(v => !v) || !Number.isFinite(quantity) || quantity < 1) {
    return res.redirect(back + encodeURIComponent('All fields are required, and quantity must be at least 1'));
  }
  const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.p2p.id);
  const who = firstNameOf(me);
  const info = db.prepare(`
    INSERT INTO purchase_orders (po_number, store_name, brand, asin, product_name, quantity, created_by, created_by_name)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(f.po_number, f.store_name, f.brand, f.asin, f.product_name, quantity, me.id, who);
  db.prepare(`INSERT INTO po_events (po_id, status, detail, user_id, user_name) VALUES (?,?,?,?,?)`)
    .run(info.lastInsertRowid, 'po_placed', `${quantity} units of ${f.product_name}`, me.id, who);
  notify('p2p', `${f.po_number}: PO placed by ${who}`);
  res.redirect('/p2p?msg=' + encodeURIComponent(`PO ${f.po_number} placed by ${who}`));
});

// Advance one step along the pipeline. Every transition needs a photo; the
// move to Shipped also needs carrier, tracking ID and pallet count.
app.post('/p2p/pos/:id/advance', requireP2p, (req, res) => {
  poPhotoUpload.single('photo')(req, res, err => {
    const fail = m => {
      if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
      return res.redirect('/p2p?err=' + encodeURIComponent(m));
    };
    if (err) return fail(err.message);

    const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
    if (!po) return fail('Purchase order not found');
    const next = PO_NEXT[po.status];
    if (!next) return fail(`${po.po_number} is already at the final status`);
    // Guard against a double submit landing the PO two states forward.
    if (req.body.from && req.body.from !== po.status) {
      return fail(`${po.po_number} has already moved to "${PO_LABELS[po.status]}"`);
    }
    if (PO_PHOTO_REQUIRED.includes(next) && !req.file) {
      return fail(`A photo is required to move ${po.po_number} to "${PO_LABELS[next]}"`);
    }

    let detail = '';
    let landedStatus = next;
    if (next === 'sent_to_amazon') {
      const sending = wholeNumber(req.body.pallets_sent);
      const total = po.pallets || 0;
      const already = po.pallets_sent || 0;
      const remaining = Math.max(0, total - already);
      if (sending === null) {
        return fail('Pallets sent must be a whole number greater than zero - no decimals or negatives');
      }
      if (sending > remaining) {
        return fail(`${po.po_number} has only ${remaining} pallet(s) left to send`);
      }
      const nowSent = already + sending;
      // Short of the received count means the PO stays open for a further send.
      landedStatus = nowSent >= total ? 'sent_to_amazon' : 'partial_sent';
      db.prepare('UPDATE purchase_orders SET pallets_sent=? WHERE id=?').run(nowSent, po.id);
      detail = `${sending} pallet(s) sent - ${nowSent} of ${total} total` +
        (landedStatus === 'partial_sent' ? ` (${total - nowSent} still in the warehouse)` : '');
    }
    if (next === 'shipped') {
      const carrier = (req.body.carrier || '').trim();
      const tracking_id = (req.body.tracking_id || '').trim();
      const pallets = wholeNumber(req.body.pallets);
      if (!carrier || !tracking_id) {
        return fail('Carrier and tracking ID are both required to mark a PO shipped');
      }
      if (pallets === null) {
        return fail('Number of pallets must be a whole number greater than zero - no decimals or negatives');
      }
      db.prepare('UPDATE purchase_orders SET carrier=?, tracking_id=?, pallets=? WHERE id=?')
        .run(carrier, tracking_id, pallets, po.id);
      detail = `${carrier} / ${tracking_id} / ${pallets} pallet(s)`;
    }

    const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.p2p.id);
    const who = firstNameOf(me);
    let photoName = null;
    if (req.file) {
      photoName = `po${po.id}-${landedStatus}-${Date.now()}${PHOTO_TYPES[req.file.mimetype]}`;
      fs.renameSync(req.file.path, path.join(PO_PHOTO_DIR, photoName));
    }

    db.prepare("UPDATE purchase_orders SET status=?, updated_at=datetime('now') WHERE id=?")
      .run(landedStatus, po.id);
    db.prepare('INSERT INTO po_events (po_id, status, photo, detail, user_id, user_name) VALUES (?,?,?,?,?,?)')
      .run(po.id, landedStatus, photoName, detail || null, me.id, who);
    notify('p2p', `${po.po_number}: ${PO_LABELS[landedStatus]} by ${who}`);
    res.redirect('/p2p?msg=' + encodeURIComponent(`${po.po_number} - ${PO_LABELS[landedStatus]} by ${who}`));
  });
});

// Status photo (P2P users and admin).
app.get('/po-photo/:eventId', (req, res) => {
  const s = req.session || {};
  if (!s.p2p && !s.admin) return res.redirect('/p2p');
  const ev = db.prepare('SELECT * FROM po_events WHERE id=?').get(req.params.eventId);
  if (!ev || !ev.photo) return res.status(404).send('Not found');
  res.sendFile(path.join(PO_PHOTO_DIR, ev.photo));
});

// ---- accounts (payment verification) ----
app.get('/accounts', (req, res, next) => {
  if (!req.session.accounts) return renderLogin(res, 'accounts');
  next();
}, (req, res) => {
  const q = (req.query.q || '').trim();
  const f = searchFilter(q, true);
  const orders = db.prepare(`
    SELECT o.*, u.client_name AS account_name
    FROM orders o JOIN users u ON u.id = o.client_id
    WHERE 1=1${f.clause}
    ${RECENT_FIRST}`).all(...f.params);
  res.render('accounts', {
    user: req.session.accounts, orders, q,
    payLabels: PAY_LABELS,
    notifs: getNotifs('accounts'),
    tab: req.query.tab === 'notifications' ? 'notifications' : 'invoices',
    msg: req.query.msg || null,
    err: req.query.err || null
  });
});

// Accounts verifies a payment (only from 'verification' state)
app.post('/accounts/orders/:id/verify', requireAccounts, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND payment_status='verification'").get(req.params.id);
  if (!order) return res.redirect('/accounts?err=' + encodeURIComponent('Order is not awaiting verification'));
  db.prepare("UPDATE orders SET payment_status='paid', updated_at=datetime('now') WHERE id=?").run(order.id);
  notify('client', `${order.invoice_no}: payment verified - shipment details unlocked`, order.client_id);
  notify('admin', `${order.invoice_no}: payment verified by accounts`);
  emailEvent({ ...order, payment_status: 'paid' }, 'Payment verified',
    `Accounts (${req.session.accounts.username}) verified payment. The invoice is now Paid and the client can enter shipment details.`,
    ['payment']);
  res.redirect('/accounts?msg=Payment verified');
});

// Accounts rejects (payment not received) -> back to unpaid
app.post('/accounts/orders/:id/reject', requireAccounts, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND payment_status='verification'").get(req.params.id);
  if (!order) return res.redirect('/accounts?err=' + encodeURIComponent('Order is not awaiting verification'));
  db.prepare("UPDATE orders SET payment_status='unpaid', updated_at=datetime('now') WHERE id=?").run(order.id);
  notify('client', `${order.invoice_no}: payment not received - invoice set back to unpaid`, order.client_id);
  emailEvent({ ...order, payment_status: 'unpaid' }, 'Payment NOT received',
    `Accounts (${req.session.accounts.username}) marked the payment as not received. The invoice is back to Unpaid.`,
    ['payment']);
  res.redirect('/accounts?msg=Payment rejected - set back to unpaid');
});

// ---- client ----
app.get('/clients', (req, res, next) => {
  if (!req.session.client) return renderLogin(res, 'client');
  next();
}, (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.client.id);
  const q = (req.query.q || '').trim();
  const f = searchFilter(q);
  const orders = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.fnsku_file IS NULL) AS missing_labels,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.ship_info IS NULL) AS missing_info,
      ${missingSlabelsSql} AS missing_slabels
    FROM orders o WHERE o.client_id=?${f.clause} ${RECENT_FIRST}`).all(me.id, ...f.params);
  // FNSKU modal: ?fnsku=<orderId> / shipping-label modal: ?shiplabel=<orderId>
  let fnskuOrder = null, fnskuItems = [], shipLabelOrder = null, shipLabelItems = [];
  if (req.query.fnsku) {
    fnskuOrder = db.prepare('SELECT * FROM orders WHERE id=? AND client_id=?').get(req.query.fnsku, me.id);
    if (fnskuOrder) fnskuItems = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(fnskuOrder.id);
  } else if (req.query.shiplabel) {
    shipLabelOrder = db.prepare("SELECT * FROM orders WHERE id=? AND client_id=? AND shipment_status IN ('prep_done','sent_to_amazon')")
      .get(req.query.shiplabel, me.id);
    if (shipLabelOrder) shipLabelItems = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(shipLabelOrder.id);
  }
  const labelsByItem = {};
  for (const it of shipLabelItems) {
    labelsByItem[it.id] = db.prepare('SELECT * FROM shipping_labels WHERE item_id=? ORDER BY id').all(it.id);
  }
  res.render('client', {
    user: req.session.client, me, orders, q,
    shipmentStatuses: CLIENT_SHIP_STATUSES,
    payLabels: PAY_LABELS,
    shipLabels: SHIP_LABELS,
    notifs: getNotifs('client', me.id),
    fnskuOrder, fnskuItems, shipLabelOrder, shipLabelItems, labelsByItem,
    tab: req.query.tab === 'new-order' ? 'new-order' : 'orders',
    msg: req.query.msg || null,
    err: req.query.err || null
  });
});

// Client marks payment as sent, attaching a proof-of-payment screenshot -> verification
app.post('/clients/orders/:id/payment-sent', requireClient, (req, res) => {
  proofUpload.single('proof')(req, res, err => {
    if (err) return res.redirect('/clients?err=' + encodeURIComponent(err.message));
    const order = db.prepare("SELECT * FROM orders WHERE id=? AND client_id=? AND payment_status='unpaid'")
      .get(req.params.id, req.session.client.id);
    if (!order) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.redirect('/clients?err=' + encodeURIComponent('Order not found or not in unpaid state'));
    }
    if (!req.file) {
      return res.redirect('/clients?err=' + encodeURIComponent('Attach a screenshot of the payment before marking it sent'));
    }
    const finalName = `order${order.id}-payment${PROOF_TYPES[req.file.mimetype]}`;
    fs.renameSync(req.file.path, path.join(PAYMENT_DIR, finalName));
    db.prepare(`UPDATE orders SET payment_status='verification', payment_proof=?,
                payment_proof_uploaded_at=datetime('now'), updated_at=datetime('now')
                WHERE id=?`).run(finalName, order.id);

    notify('accounts', `${order.invoice_no}: client marked payment sent (proof attached) - please verify`);
    notify('admin', `${order.invoice_no}: payment marked sent by ${order.business_name}`);
    emailEvent({ ...order, payment_status: 'verification' }, 'Payment sent - proof uploaded',
      `${order.business_name} marked this invoice as paid and uploaded a proof-of-payment screenshot ` +
      `(${req.file.originalname}).\nAwaiting verification by accounts.`,
      ['payment']);
    res.redirect('/clients?msg=' + encodeURIComponent('Payment marked as sent - awaiting verification by accounts'));
  });
});

// Payment proof (client: own only; admin, accounts & warehouse: any). Shown inline.
app.get('/payment-proof/:orderId', (req, res) => {
  const s = req.session || {};
  if (!s.admin && !s.accounts && !s.warehouse && !s.client) return res.redirect('/clients');
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.orderId);
  if (!order || !order.payment_proof) return res.status(404).send('Not found');
  if (!s.admin && !s.accounts && !s.warehouse && order.client_id !== s.client.id) {
    return res.status(403).send('Forbidden');
  }
  res.sendFile(path.join(PAYMENT_DIR, order.payment_proof));
});

// Submit order (multiple products) -> generate + email invoice
app.post('/clients/orders', requireClient, async (req, res) => {
  const { name, business_name, email, store_name, brand_name } = req.body;
  const back = '/clients?tab=new-order&err=';

  let items = req.body.items ? Object.values(req.body.items) : [];
  items = items
    .map(i => {
      const polybagType = i.polybag === 'polybag' ? 'Poly bag' : i.polybag === 'bubblewrap' ? 'Bubble wrap' : null;
      return {
        asin: (i.asin || '').trim(),
        quantity: parseInt(i.quantity, 10),
        polybag: polybagType ? 1 : 0,
        polybag_type: polybagType
      };
    })
    .filter(i => i.asin || i.quantity);
  if (!name || !business_name || !email || !brand_name || items.length === 0) {
    return res.redirect(back + encodeURIComponent('All fields are required, including at least one product'));
  }
  if (items.some(i => !i.asin || !i.quantity || i.quantity < 1)) {
    return res.redirect(back + encodeURIComponent('Every product needs an ASIN and a quantity of at least 1'));
  }

  const quantity = items.reduce((s, i) => s + i.quantity, 0);
  const polybagQty = items.reduce((s, i) => s + (i.polybag ? i.quantity : 0), 0);
  const rates = getEffectiveRates(req.session.client.id, quantity);
  const cartons = Math.ceil(quantity / 50);

  let subtotal =
    rates.inbound * quantity +
    rates.fnsku * quantity +
    rates.polybag * polybagQty +
    rates.carton * cartons;
  subtotal = Math.round(subtotal * 100) / 100;
  const total = Math.round(subtotal * (1 - rates.discount_pct / 100) * 100) / 100;

  const prepSummary = 'Receiving, FNSKU Labeling, Cartonization' +
    (polybagQty > 0 ? `, Poly bag / bubble wrap (${polybagQty} units)` : '');

  const invoice_no = nextInvoiceNo();
  const info = db.prepare(`
    INSERT INTO orders (client_id, invoice_no, name, business_name, email, store_name, brand_name, asin,
      prep_requirement, quantity, polybag_qty, cartons, rate_inbound, rate_fnsku, rate_polybag, rate_carton,
      discount_pct, subtotal, total)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.session.client.id, invoice_no, name.trim(), business_name.trim(), email.trim(),
         store_name || null, brand_name.trim(), items.map(i => i.asin).join(', '),
         prepSummary, quantity, polybagQty, cartons,
         rates.inbound, rates.fnsku, rates.polybag, rates.carton,
         rates.discount_pct, subtotal, total);

  const insertItem = db.prepare('INSERT INTO order_items (order_id, asin, quantity, polybag, polybag_type) VALUES (?,?,?,?,?)');
  for (const i of items) insertItem.run(info.lastInsertRowid, i.asin, i.quantity, i.polybag, i.polybag_type);

  touchOrder(info.lastInsertRowid);
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(info.lastInsertRowid);
  notify('admin', `New order ${invoice_no} from ${order.business_name} (${quantity} units, $${total.toFixed(2)})`);
  notify('accounts', `New invoice ${invoice_no} for ${order.business_name} ($${total.toFixed(2)})`);
  emailEvent(order, 'New prep order submitted',
    `${order.business_name} submitted a new prep order.\n` +
    `Products:\n${items.map(i => `  - ${i.asin} x ${i.quantity}${i.polybag_type ? ` (${i.polybag_type})` : ''}`).join('\n')}`);
  try {
    const pdfPath = await generateInvoicePdf(order);
    await sendInvoiceEmail(order, pdfPath);
  } catch (e) {
    console.error('Invoice generation/email failed:', e.message);
  }
  res.redirect('/clients?msg=' + encodeURIComponent(`Order submitted - invoice ${invoice_no} generated`));
});

// Client updates shipment info (only after invoice is paid; locked once admin marks received)
app.post('/clients/orders/:id/shipment', requireClient, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id=? AND client_id=?')
    .get(req.params.id, req.session.client.id);
  if (!order) return res.redirect('/clients?err=Order not found');
  if (order.payment_status !== 'paid') {
    return res.redirect('/clients?err=' + encodeURIComponent('Shipment details unlock after the invoice is marked paid'));
  }
  if (['received', 'prep', 'prep_done', 'sent_to_amazon'].includes(order.shipment_status)) {
    return res.redirect('/clients?err=' + encodeURIComponent('Shipment already received by warehouse - details are locked'));
  }
  if (order.shipment_status === 'shipped') {
    const missing = db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id=? AND fnsku_file IS NULL').get(order.id).c;
    if (missing === 0) {
      return res.redirect('/clients?err=' + encodeURIComponent('Shipment details are locked once shipped and all FNSKU labels are uploaded'));
    }
  }
  const status = CLIENT_SHIP_STATUSES.includes(req.body.shipment_status) ? req.body.shipment_status : order.shipment_status;
  db.prepare("UPDATE orders SET shipment_status=?, carrier=?, tracking_id=?, updated_at=datetime('now') WHERE id=?")
    .run(status, req.body.carrier || null, req.body.tracking_id || null, order.id);
  if (status === 'shipped' && order.shipment_status !== 'shipped') {
    notify('warehouse', `${order.invoice_no}: marked shipped by ${order.business_name} (${req.body.carrier || '-'} / ${req.body.tracking_id || '-'})`);
  }
  // "Tracking added" copies the tracking mailbox - on first entry and on any later correction.
  const newTracking = (req.body.tracking_id || '').trim();
  const updated = { ...order, shipment_status: status, carrier: req.body.carrier || null, tracking_id: newTracking || null };
  if (newTracking && newTracking !== (order.tracking_id || '')) {
    emailEvent(updated, 'Tracking added',
      `${order.business_name} added tracking for this shipment.\n\n` +
      `Carrier:     ${req.body.carrier || '-'}\n` +
      `Tracking ID: ${newTracking}\n` +
      `Status:      ${SHIP_LABELS[status] || status}` +
      (order.tracking_id ? `\n\n(Replaces previous tracking ID: ${order.tracking_id})` : ''),
      ['tracking']);
  } else if (status === 'shipped' && order.shipment_status !== 'shipped') {
    emailEvent(updated, 'Marked shipped',
      `${order.business_name} marked this shipment as sent to the warehouse.\n\n` +
      `Carrier:     ${req.body.carrier || '-'}\n` +
      `Tracking ID: ${newTracking || '-'}`);
  }
  if (status === 'shipped') {
    // open the FNSKU upload popup only if any product is still missing its label
    const missing = db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id=? AND fnsku_file IS NULL').get(order.id).c;
    if (missing > 0) {
      return res.redirect(`/clients?fnsku=${order.id}&msg=` + encodeURIComponent('Shipment details saved - please upload FNSKU labels (PDF) for each ASIN'));
    }
  }
  res.redirect('/clients?msg=Shipment details updated');
});

// Upload FNSKU label PDFs (one per order item)
app.post('/clients/orders/:id/fnsku', requireClient, (req, res) => {
  fnskuUpload.any()(req, res, err => {
    if (err) return res.redirect(`/clients?fnsku=${req.params.id}&err=` + encodeURIComponent(err.message));
    const order = db.prepare('SELECT * FROM orders WHERE id=? AND client_id=?')
      .get(req.params.id, req.session.client.id);
    if (!order) return res.redirect('/clients?err=Order not found');
    let saved = 0;
    for (const file of req.files || []) {
      const m = file.fieldname.match(/^fnsku_(\d+)$/);
      if (!m) { fs.unlinkSync(file.path); continue; }
      const item = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(m[1], order.id);
      if (!item) { fs.unlinkSync(file.path); continue; }
      const finalName = `order${order.id}-item${item.id}.pdf`;
      fs.renameSync(file.path, path.join(FNSKU_DIR, finalName));
      db.prepare("UPDATE order_items SET fnsku_file=?, fnsku_uploaded_at=datetime('now') WHERE id=?")
        .run(finalName, item.id);
      saved++;
    }
    if (!saved) return res.redirect(`/clients?fnsku=${order.id}&err=` + encodeURIComponent('No PDF files were uploaded'));
    touchOrder(order.id);
    const remaining = db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id=? AND fnsku_file IS NULL').get(order.id).c;
    if (remaining === 0) notify('warehouse', `${order.invoice_no}: all FNSKU labels uploaded`);
    emailEvent(order, 'FNSKU labels uploaded',
      `${order.business_name} uploaded ${saved} FNSKU label(s).` +
      (remaining ? ` ${remaining} ASIN(s) still missing labels.` : ' All ASINs now have labels.'));
    res.redirect('/clients?msg=' + encodeURIComponent(
      remaining ? `${saved} FNSKU label(s) uploaded - ${remaining} ASIN(s) still missing labels` : 'All FNSKU labels uploaded'));
  });
});

// Upload shipping label PDFs (one per order item, after warehouse prep done + ship info)
app.post('/clients/orders/:id/shipping-labels', requireClient, (req, res) => {
  fnskuUpload.any()(req, res, err => {
    if (err) return res.redirect(`/clients?shiplabel=${req.params.id}&err=` + encodeURIComponent(err.message));
    const order = db.prepare("SELECT * FROM orders WHERE id=? AND client_id=? AND shipment_status='prep_done'")
      .get(req.params.id, req.session.client.id);
    if (!order) return res.redirect('/clients?err=' + encodeURIComponent('Order not found or prep is not done yet'));
    let saved = 0;
    const insertLabel = db.prepare('INSERT INTO shipping_labels (item_id, file) VALUES (?,?)');
    for (const file of req.files || []) {
      const m = file.fieldname.match(/^slabel_(\d+)$/);
      if (!m) { fs.unlinkSync(file.path); continue; }
      const item = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(m[1], order.id);
      if (!item || !item.ship_info) { fs.unlinkSync(file.path); continue; }
      const finalName = `order${order.id}-item${item.id}-${Date.now()}-${saved}.pdf`;
      fs.renameSync(file.path, path.join(SHIPLABEL_DIR, finalName));
      insertLabel.run(item.id, finalName);
      saved++;
    }
    if (!saved) return res.redirect(`/clients?shiplabel=${order.id}&err=` + encodeURIComponent('No PDF files were uploaded'));
    touchOrder(order.id);
    const remaining = db.prepare(`
      SELECT COUNT(*) c FROM order_items i WHERE i.order_id=?
        AND NOT EXISTS (SELECT 1 FROM shipping_labels l WHERE l.item_id = i.id)`).get(order.id).c;
    if (remaining === 0) notify('warehouse', `${order.invoice_no}: shipping labels uploaded by client - ready to send to Amazon`);
    emailEvent(order, 'Shipping labels uploaded',
      `${order.business_name} uploaded ${saved} shipping label(s).` +
      (remaining ? ` ${remaining} ASIN(s) still missing a label.` : ' Every ASIN now has a label; ready to send to Amazon.'));
    res.redirect('/clients?msg=' + encodeURIComponent(
      remaining ? `${saved} shipping label(s) uploaded - ${remaining} ASIN(s) still missing` : `${saved} shipping label(s) uploaded - warehouse notified`));
  });
});

// Shipping label download (warehouse/admin/accounts: any; client: own only)
app.get('/shiplabel/:labelId.pdf', (req, res) => {
  const s = req.session || {};
  if (!s.admin && !s.accounts && !s.warehouse && !s.client) return res.redirect('/clients');
  const label = db.prepare(`
    SELECT l.*, i.asin, o.client_id FROM shipping_labels l
    JOIN order_items i ON i.id = l.item_id JOIN orders o ON o.id = i.order_id
    WHERE l.id=?`).get(req.params.labelId);
  if (!label) return res.status(404).send('Not found');
  if (!s.admin && !s.accounts && !s.warehouse && label.client_id !== s.client.id) {
    return res.status(403).send('Forbidden');
  }
  res.download(path.join(SHIPLABEL_DIR, label.file), `ShippingLabel-${label.asin}-${label.id}.pdf`);
});

// FNSKU label download (warehouse/admin/accounts: any; client: own only)
app.get('/fnsku/:itemId.pdf', (req, res) => {
  const s = req.session || {};
  if (!s.admin && !s.accounts && !s.warehouse && !s.client) return res.redirect('/clients');
  const item = db.prepare(`
    SELECT i.*, o.client_id FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.id=?`)
    .get(req.params.itemId);
  if (!item || !item.fnsku_file) return res.status(404).send('Not found');
  if (!s.admin && !s.accounts && !s.warehouse && item.client_id !== s.client.id) {
    return res.status(403).send('Forbidden');
  }
  res.download(path.join(FNSKU_DIR, item.fnsku_file), `FNSKU-${item.asin}.pdf`);
});

// Invoice download (client: own only; admin & accounts: any)
app.get('/invoices/:invoiceNo.pdf', async (req, res) => {
  const s = req.session || {};
  if (!s.admin && !s.accounts && !s.warehouse && !s.client) return res.redirect('/clients');
  const order = db.prepare('SELECT * FROM orders WHERE invoice_no=?').get(req.params.invoiceNo);
  if (!order) return res.status(404).send('Not found');
  if (!s.admin && !s.accounts && !s.warehouse && order.client_id !== s.client.id) {
    return res.status(403).send('Forbidden');
  }
  let file = path.join(INVOICE_DIR, `${order.invoice_no}.pdf`);
  if (!require('fs').existsSync(file)) file = await generateInvoicePdf(order);
  res.download(file, `${order.invoice_no}.pdf`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`3PL portal running on http://localhost:${PORT}`));
