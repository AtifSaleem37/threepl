const nodemailer = require('nodemailer');

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
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
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

module.exports = { sendInvoiceEmail };
