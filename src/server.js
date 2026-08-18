require('./env');
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const multer = require('multer');
const { db, getGlobalRates, setGlobalRates, getEffectiveRates, nextInvoiceNo } = require('./db');
const { generateInvoicePdf, buildLineItems, INVOICE_DIR } = require('./invoice');
const { sendInvoiceEmail } = require('./mailer');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FNSKU_DIR = path.join(DATA_DIR, 'fnsku');
const SHIPLABEL_DIR = path.join(DATA_DIR, 'shiplabels');
fs.mkdirSync(SHIPLABEL_DIR, { recursive: true });
const fnskuUpload = multer({
  storage: multer.diskStorage({
    destination: FNSKU_DIR,
    filename: (req, file, cb) => cb(null, `tmp-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' && /\.pdf$/i.test(file.originalname);
    ok ? cb(null) : cb(new Error('Only PDF files are accepted for FNSKU labels'));
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

// ---- notifications (keep only the last 5 per audience) ----
function notify(role, message, clientId = null) {
  db.prepare('INSERT INTO notifications (role, client_id, message) VALUES (?,?,?)').run(role, clientId, message);
  db.prepare(`DELETE FROM notifications WHERE role=? AND client_id IS ? AND id NOT IN (
    SELECT id FROM notifications WHERE role=? AND client_id IS ? ORDER BY id DESC LIMIT 5)`)
    .run(role, clientId, role, clientId);
}
const getNotifs = (role, clientId = null) =>
  db.prepare('SELECT * FROM notifications WHERE role=? AND client_id IS ? ORDER BY id DESC LIMIT 5')
    .all(role, clientId);
const HOME = { admin: '/admin', client: '/clients', accounts: '/accounts', warehouse: '/warehouse' };
const PORTALS = {
  admin: { path: '/admin', label: 'Admin' },
  client: { path: '/clients', label: 'Client' },
  accounts: { path: '/accounts', label: 'Accounts' },
  warehouse: { path: '/warehouse', label: 'Warehouse' }
};

// Each role has its own session slot (req.session.admin / .client / .accounts),
// so different portals can be logged in simultaneously in the same browser.
const requireRole = role => (req, res, next) =>
  req.session[role] ? next() : res.redirect(PORTALS[role].path);
const requireAdmin = requireRole('admin');
const requireClient = requireRole('client');
const requireAccounts = requireRole('accounts');
const requireWarehouse = requireRole('warehouse');

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
  const orders = db.prepare(`
    SELECT o.*, u.client_name AS account_name
    FROM orders o JOIN users u ON u.id = o.client_id
    ORDER BY o.id DESC`).all();
  const clients = db.prepare(`
    SELECT u.*, r.inbound AS o_inbound, r.fnsku AS o_fnsku, r.polybag AS o_polybag,
           r.carton AS o_carton, r.discount_pct AS o_discount
    FROM users u LEFT JOIN client_rates r ON r.client_id = u.id
    WHERE u.role='client' ORDER BY u.client_name`).all();
  const staffUsers = db.prepare("SELECT * FROM users WHERE role IN ('accounts','warehouse') ORDER BY role, username").all();
  const TABS = ['orders', 'client-user', 'staff', 'clients'];
  res.render('admin', {
    user: req.session.admin,
    orders, clients, staffUsers,
    rates: getGlobalRates(),
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
  const role = ['accounts', 'warehouse'].includes(req.body.role) ? req.body.role : 'client';
  const tab = role === 'client' ? 'client-user' : 'staff';
  if (!username || !password || !client_name) {
    return res.redirect(`/admin?tab=${tab}&err=Missing required fields`);
  }
  try {
    db.prepare(`INSERT INTO users (role,username,password_hash,client_name,business_name,email,store_name)
                VALUES (?,?,?,?,?,?,?)`)
      .run(role, username.trim(), bcrypt.hashSync(password, 10), client_name.trim(),
           business_name || null, email || null, store_name || null);
    const label = role === 'client' ? 'Client' : role === 'accounts' ? 'Accounts user' : 'Warehouse user';
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
  db.prepare("UPDATE users SET password_hash=? WHERE id=? AND role IN ('client','accounts','warehouse')")
    .run(bcrypt.hashSync(req.body.password, 10), req.params.id);
  res.redirect(`/admin?tab=${tab}&msg=Password updated`);
});

// Global rates
app.post('/admin/rates', requireAdmin, (req, res) => {
  const { inbound, fnsku, polybag, carton, discount_pct } = req.body;
  setGlobalRates({
    inbound: parseFloat(inbound) || 0,
    fnsku: parseFloat(fnsku) || 0,
    polybag: parseFloat(polybag) || 0,
    carton: parseFloat(carton) || 0,
    discount_pct: parseFloat(discount_pct) || 0
  });
  res.redirect('/admin?tab=clients&msg=Global rates updated');
});

// Per-client rate overrides (blank field = use global)
app.post('/admin/clients/:id/rates', requireAdmin, (req, res) => {
  const num = v => (v === '' || v === undefined ? null : parseFloat(v));
  db.prepare(`INSERT INTO client_rates (client_id,inbound,fnsku,polybag,carton,discount_pct)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(client_id) DO UPDATE SET
                inbound=excluded.inbound, fnsku=excluded.fnsku, polybag=excluded.polybag,
                carton=excluded.carton, discount_pct=excluded.discount_pct`)
    .run(req.params.id, num(req.body.inbound), num(req.body.fnsku),
         num(req.body.polybag), num(req.body.carton), num(req.body.discount_pct));
  res.redirect('/admin?tab=clients&msg=Client rates updated');
});

// ---- warehouse ----
const WH_STATUSES = "('shipped','received','prep','prep_done','sent_to_amazon')";
app.get('/warehouse', (req, res, next) => {
  if (!req.session.warehouse) return renderLogin(res, 'warehouse');
  next();
}, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id=o.id AND i.ship_info IS NULL) AS missing_info,
      ${missingSlabelsSql} AS missing_slabels
    FROM orders o
    WHERE o.shipment_status IN ${WH_STATUSES}
    ORDER BY CASE o.shipment_status WHEN 'shipped' THEN 0 WHEN 'received' THEN 1 WHEN 'prep' THEN 2 WHEN 'prep_done' THEN 3 ELSE 4 END, o.id DESC`).all();
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
    user: req.session.warehouse, orders, itemsByOrder, labelsByItem,
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
    db.prepare('UPDATE orders SET shipment_status=? WHERE id=?').run(to, order.id);
    notify('client', `${order.invoice_no}: ${doneMsg}`, order.client_id);
    if (to === 'received') notify('admin', `${order.invoice_no}: received by warehouse`);
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
  db.prepare("UPDATE orders SET shipment_status='sent_to_amazon' WHERE id=?").run(order.id);
  notify('client', `${order.invoice_no}: shipment sent to Amazon`, order.client_id);
  notify('admin', `${order.invoice_no}: sent to Amazon by warehouse`);
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
  const missing = db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id=? AND ship_info IS NULL').get(order.id).c;
  if (missing === 0) {
    notify('client', `${order.invoice_no}: shipment info added - please upload shipping labels for each ASIN`, order.client_id);
  }
  res.redirect('/warehouse?msg=' + encodeURIComponent(
    missing ? `Shipment info saved - ${missing} ASIN(s) still missing info` : 'Shipment info saved for all ASINs - client notified'));
});

// ---- accounts (payment verification) ----
app.get('/accounts', (req, res, next) => {
  if (!req.session.accounts) return renderLogin(res, 'accounts');
  next();
}, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, u.client_name AS account_name
    FROM orders o JOIN users u ON u.id = o.client_id
    ORDER BY CASE o.payment_status WHEN 'verification' THEN 0 WHEN 'unpaid' THEN 1 ELSE 2 END, o.id DESC`).all();
  res.render('accounts', {
    user: req.session.accounts, orders,
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
  db.prepare("UPDATE orders SET payment_status='paid' WHERE id=?").run(order.id);
  notify('client', `${order.invoice_no}: payment verified - shipment details unlocked`, order.client_id);
  notify('admin', `${order.invoice_no}: payment verified by accounts`);
  res.redirect('/accounts?msg=Payment verified');
});

// Accounts rejects (payment not received) -> back to unpaid
app.post('/accounts/orders/:id/reject', requireAccounts, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND payment_status='verification'").get(req.params.id);
  if (!order) return res.redirect('/accounts?err=' + encodeURIComponent('Order is not awaiting verification'));
  db.prepare("UPDATE orders SET payment_status='unpaid' WHERE id=?").run(order.id);
  notify('client', `${order.invoice_no}: payment not received - invoice set back to unpaid`, order.client_id);
  res.redirect('/accounts?msg=Payment rejected - set back to unpaid');
});

// ---- client ----
app.get('/clients', (req, res, next) => {
  if (!req.session.client) return renderLogin(res, 'client');
  next();
}, (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.client.id);
  const orders = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.fnsku_file IS NULL) AS missing_labels,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id AND i.ship_info IS NULL) AS missing_info,
      ${missingSlabelsSql} AS missing_slabels
    FROM orders o WHERE o.client_id=? ORDER BY o.id DESC`).all(me.id);
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
    user: req.session.client, me, orders,
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

// Client marks payment as sent -> goes to verification
app.post('/clients/orders/:id/payment-sent', requireClient, (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id=? AND client_id=? AND payment_status='unpaid'")
    .get(req.params.id, req.session.client.id);
  if (!order) return res.redirect('/clients?err=' + encodeURIComponent('Order not found or not in unpaid state'));
  db.prepare("UPDATE orders SET payment_status='verification' WHERE id=?").run(order.id);
  notify('accounts', `${order.invoice_no}: client marked payment sent - please verify`);
  notify('admin', `${order.invoice_no}: payment marked sent by ${order.business_name}`);
  res.redirect('/clients?msg=' + encodeURIComponent('Payment marked as sent - awaiting verification by accounts'));
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
  const rates = getEffectiveRates(req.session.client.id);
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

  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(info.lastInsertRowid);
  notify('admin', `New order ${invoice_no} from ${order.business_name} (${quantity} units, $${total.toFixed(2)})`);
  notify('accounts', `New invoice ${invoice_no} for ${order.business_name} ($${total.toFixed(2)})`);
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
  db.prepare('UPDATE orders SET shipment_status=?, carrier=?, tracking_id=? WHERE id=?')
    .run(status, req.body.carrier || null, req.body.tracking_id || null, order.id);
  if (status === 'shipped' && order.shipment_status !== 'shipped') {
    notify('warehouse', `${order.invoice_no}: marked shipped by ${order.business_name} (${req.body.carrier || '-'} / ${req.body.tracking_id || '-'})`);
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
    const remaining = db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id=? AND fnsku_file IS NULL').get(order.id).c;
    if (remaining === 0) notify('warehouse', `${order.invoice_no}: all FNSKU labels uploaded`);
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
    const remaining = db.prepare(`
      SELECT COUNT(*) c FROM order_items i WHERE i.order_id=?
        AND NOT EXISTS (SELECT 1 FROM shipping_labels l WHERE l.item_id = i.id)`).get(order.id).c;
    if (remaining === 0) notify('warehouse', `${order.invoice_no}: shipping labels uploaded by client - ready to send to Amazon`);
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
