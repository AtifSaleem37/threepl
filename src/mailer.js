const nodemailer = require('nodemailer');

// All portal mail is sent from one identity; recipients are per-audience and
// overridable via env so they can be changed without a deploy.
const mailFrom = () => process.env.MAIL_FROM || '3pl@viraldistributors.com';
const EVENTS_TO = () => process.env.MAIL_EVENTS_TO || 'tanveer@viraldistributors.com';
const TRACKING_TO = () => process.env.MAIL_TRACKING_TO || 'thomas@viraldistributors.com';
const PAYMENT_TO = () => process.env.MAIL_PAYMENT_TO || 'accounting@viralvamp.com';

function getTransport() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendInvoiceEmail(order, pdfPath) {
  const transport = getTransport();
  if (!transport) {
    console.log(`[mailer] SMTP not configured - skipped emailing ${order.invoice_no}`);
    return false;
  }
  await transport.sendMail({
    from: mailFrom(),
    to: order.email,
    subject: `Invoice ${order.invoice_no} - ${process.env.COMPANY_NAME || '3PL Services'}`,
    text:
      `Hi ${order.name},\n\n` +
      `Please find attached invoice ${order.invoice_no} for your FBA prep order ` +
      `(${order.quantity} units, ASIN ${order.asin}).\n\n` +
      `Total due: $${order.total.toFixed(2)}. Payment terms: Advance.\n\n` +
      `You can also download the invoice from your client portal.\n\nThank you.`,
    attachments: [{ filename: `${order.invoice_no}.pdf`, path: pdfPath }]
  });
  console.log(`[mailer] Invoice ${order.invoice_no} emailed to ${order.email}`);
  return true;
}

const orderSummary = o => [
  `Invoice:  ${o.invoice_no}`,
  `Client:   ${o.name}${o.business_name ? ` (${o.business_name})` : ''}`,
  o.brand_name ? `Brand:    ${o.brand_name}` : null,
  o.store_name ? `Store:    ${o.store_name}` : null,
  `ASIN(s):  ${o.asin}`,
  `Quantity: ${o.quantity} units in ${o.cartons} carton(s)`,
  `Total:    $${Number(o.total).toFixed(2)}`
].filter(Boolean).join('\n');

/**
 * Notify the operations mailbox about an order-lifecycle action.
 * `audiences` adds recipients beyond the default: 'tracking' and 'payment'.
 * Resolves false when SMTP is unconfigured; rejects only on a real send error.
 */
async function sendEventEmail({ order, subject, detail = '', audiences = [] }) {
  const to = [...new Set([
    EVENTS_TO(),
    ...(audiences.includes('tracking') ? [TRACKING_TO()] : []),
    ...(audiences.includes('payment') ? [PAYMENT_TO()] : [])
  ].filter(Boolean))];

  const transport = getTransport();
  if (!transport) {
    console.log(`[mailer] SMTP not configured - skipped "${subject}" to ${to.join(', ')}`);
    return false;
  }
  await transport.sendMail({
    from: mailFrom(),
    to: to.join(', '),
    subject: `[${order.invoice_no}] ${subject}`,
    text: `${detail}\n\n${'-'.repeat(46)}\n${orderSummary(order)}\n`
  });
  console.log(`[mailer] "${subject}" (${order.invoice_no}) emailed to ${to.join(', ')}`);
  return true;
}

module.exports = { sendInvoiceEmail, sendEventEmail };
