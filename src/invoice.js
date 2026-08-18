const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const INVOICE_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'invoices');

const NAVY = '#3d5a99';
const LIGHT = '#dce6f1';

function money(n) {
  return n === 0 ? '-' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Render an invoice PDF modeled on the 3PL SERVICE QUOTE layout.
 * Returns the absolute file path.
 */
function generateInvoicePdf(order) {
  const file = path.join(INVOICE_DIR, `${order.invoice_no}.pdf`);
  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
  const stream = fs.createWriteStream(file);
  const done = new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(file));
    stream.on('error', reject);
  });
  doc.pipe(stream);

  const company = {
    name: process.env.COMPANY_NAME || 'Viral Distributors',
    addr1: process.env.COMPANY_ADDRESS_1 || '',
    addr2: process.env.COMPANY_ADDRESS_2 || '',
    email: process.env.COMPANY_EMAIL || '',
    phone: process.env.COMPANY_PHONE || ''
  };

  // Header
  doc.font('Helvetica-Bold').fontSize(24).fillColor('#9db3d1').text('3PL SERVICE INVOICE', 40, 45);
  doc.fontSize(20).fillColor(NAVY).text(company.name, 350, 45, { width: 220, align: 'right' });

  // Company block
  let y = 95;
  doc.rect(40, y, 140, 16).fill(NAVY);
  doc.fillColor('white').font('Helvetica-Bold').fontSize(9).text('Company Name', 46, y + 4);
  doc.fillColor('black').font('Helvetica').fontSize(9);
  y += 20;
  for (const line of [company.name, company.addr1, company.addr2, company.email, `Phone: ${company.phone}`]) {
    if (line && line !== 'Phone: ') { doc.text(line, 40, y); y += 12; }
  }

  // Date / Invoice #
  doc.font('Helvetica-Bold').text('DATE', 400, 100).text('Invoice #', 400, 116);
  doc.font('Helvetica')
    .text(new Date(order.created_at + 'Z').toLocaleDateString('en-US'), 470, 100)
    .text(order.invoice_no, 470, 116);

  // Vendor / Service details
  y = Math.max(y + 8, 170);
  doc.rect(40, y, 200, 16).fill(NAVY);
  doc.fillColor('white').font('Helvetica-Bold').fontSize(9).text('VENDOR (CLIENT)', 46, y + 4);
  doc.rect(330, y, 240, 16).fill(NAVY);
  doc.fillColor('white').text('Service Details', 336, y + 4);
  doc.fillColor('black').font('Helvetica').fontSize(9);
  y += 22;
  doc.text(order.business_name, 40, y);
  doc.text(`Contact: ${order.name}`, 40, y + 12);
  doc.text(order.email, 40, y + 24);
  if (order.store_name) doc.text(`Store: ${order.store_name}`, 40, y + 36);

  doc.text('Service: Amazon FBA 3PL Services', 330, y);
  doc.text(`Quantity: ${order.quantity}${order.brand_name ? '   Brand: ' + order.brand_name : ''}`, 330, y + 12);
  doc.text(`ASIN(s): ${order.asin}`, 330, y + 24, { width: 240 });
  doc.text(`Prep: ${order.prep_requirement}`, 330, y + 36, { width: 240 });

  // Line items table
  y += 60;
  const cols = { item: 40, desc: 200, rate: 380, qty: 445, cost: 500, end: 572 };
  const header = (label, x, w) => {
    doc.fillColor('white').font('Helvetica-Bold').fontSize(9).text(label, x + 4, y + 5, { width: w - 8, align: 'left' });
  };
  doc.rect(40, y, cols.end - 40, 18).fill(NAVY);
  header('Item', cols.item, cols.desc - cols.item);
  header('DESCRIPTION', cols.desc, cols.rate - cols.desc);
  header('Cost/Unit', cols.rate, cols.qty - cols.rate);
  header('Qty', cols.qty, cols.cost - cols.qty);
  header('Cost', cols.cost, cols.end - cols.cost);
  y += 18;

  const items = buildLineItems(order);
  let shade = true;
  doc.font('Helvetica').fontSize(9);
  for (const it of items) {
    const h = 26;
    if (shade) doc.rect(40, y, cols.end - 40, h).fill(LIGHT);
    shade = !shade;
    doc.fillColor('black');
    doc.text(it.item, cols.item + 4, y + 5, { width: cols.desc - cols.item - 8 });
    doc.text(it.desc, cols.desc + 4, y + 5, { width: cols.rate - cols.desc - 8 });
    doc.text(it.rate.toFixed(2), cols.rate + 4, y + 9, { width: cols.qty - cols.rate - 8 });
    doc.text(String(it.qty), cols.qty + 4, y + 9, { width: cols.cost - cols.qty - 8 });
    doc.text(money(it.cost), cols.cost + 4, y + 9, { width: cols.end - cols.cost - 8, align: 'right' });
    y += h;
  }
  doc.rect(40, y - items.length * 26, cols.end - 40, items.length * 26).stroke('#999');

  // Totals
  y += 20;
  const label = (t, v, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('black');
    doc.text(t, 400, y);
    doc.text(v, 480, y, { width: 90, align: 'right' });
    y += 16;
  };
  label('SUBTOTAL', money(order.subtotal));
  label('DISCOUNT', order.discount_pct ? `${order.discount_pct}%` : '-');
  doc.rect(395, y - 2, 177, 18).fill(NAVY);
  doc.fillColor('white').font('Helvetica-Bold').fontSize(10)
    .text('TOTAL', 400, y + 2)
    .text(`$ ${money(order.total)}`, 480, y + 2, { width: 90, align: 'right' });
  y += 30;

  // Footer
  doc.fillColor('black').font('Helvetica-Bold').fontSize(9).text('Comments or Special Instructions', 40, y);
  doc.font('Helvetica').text(
    'Payment terms: Advance.\nDelivery hours: Monday to Friday, 9:00 AM - 5:00 PM.\nPacking list and invoice must accompany the delivery.',
    40, y + 14
  );
  doc.fontSize(9).text(
    `If you have any questions about this invoice, please contact ${company.email}`,
    40, y + 70, { width: 530, align: 'center' }
  );

  doc.end();
  return done; // Promise<string> resolving to the file path once fully written
}

function buildLineItems(order) {
  const items = [
    { item: 'Inbound Receiving & Inspection', desc: 'Includes receiving, counting, and QC', rate: order.rate_inbound, qty: order.quantity, cost: order.rate_inbound * order.quantity },
    { item: 'FBA Prep (Labeling etc.)', desc: 'Includes FNSKU labeling and warnings', rate: order.rate_fnsku, qty: order.quantity, cost: order.rate_fnsku * order.quantity }
  ];
  // per-product polybag units; fall back to old orders that stored it in prep text
  const polybagQty = order.polybag_qty > 0 ? order.polybag_qty
    : (/polybag|poly bag/i.test(order.prep_requirement || '') ? order.quantity : 0);
  if (polybagQty > 0) {
    items.push({ item: 'Poly bagging, bundling and bubble wrapping', desc: 'Poly bagging and bubble wrapping as per Amazon requirements', rate: order.rate_polybag, qty: polybagQty, cost: order.rate_polybag * polybagQty });
  }
  items.push({ item: 'Cartonization & Outbound Handling', desc: 'Carton labeling and FBA shipment prep', rate: order.rate_carton, qty: order.cartons, cost: order.rate_carton * order.cartons });
  return items;
}

module.exports = { generateInvoicePdf, buildLineItems, INVOICE_DIR };
