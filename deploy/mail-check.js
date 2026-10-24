#!/usr/bin/env node
/*
 * Diagnose portal email delivery.
 *
 *   node deploy/mail-check.js            config + SMTP auth check (sends nothing)
 *   node deploy/mail-check.js --send     also sends one test message per recipient,
 *                                        printing the exact SES response on failure
 *
 * Reads the same .env the app does, so what it reports is what the portal sees.
 */
require('../src/env');
const nodemailer = require('nodemailer');

const SEND = process.argv.includes('--send');
const cfg = {
  host: process.env.SMTP_HOST || '',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || '3pl@viraldistributors.com',
  events: process.env.MAIL_EVENTS_TO || 'tanveer@viraldistributors.com',
  tracking: process.env.MAIL_TRACKING_TO || 'thomas@viraldistributors.com',
  payment: process.env.MAIL_PAYMENT_TO || 'accounting@viralvamp.com'
};
const mask = s => (s ? s.slice(0, 4) + '*'.repeat(Math.max(0, s.length - 8)) + s.slice(-4) : '(empty)');
const show = s => (s ? s : '(EMPTY)');

console.log('\n=== resolved mail config ===');
console.log(`  SMTP_HOST        ${show(cfg.host)}`);
console.log(`  SMTP_PORT        ${cfg.port}`);
console.log(`  SMTP_USER        ${show(cfg.user)}`);
console.log(`  SMTP_PASS        ${cfg.pass ? mask(cfg.pass) : '(EMPTY)'}`);
console.log(`  MAIL_FROM        ${cfg.from}`);
console.log(`  MAIL_EVENTS_TO   ${cfg.events}`);
console.log(`  MAIL_TRACKING_TO ${cfg.tracking}`);
console.log(`  MAIL_PAYMENT_TO  ${cfg.payment}`);

// This is the exact condition mailer.js uses to decide whether to send at all.
if (!cfg.host || !cfg.user) {
  console.log('\n  >> SMTP_HOST or SMTP_USER is empty, so the portal SKIPS every');
  console.log('     send and logs "[mailer] SMTP not configured". Fix .env, then');
  console.log('     sudo systemctl restart threepl\n');
  process.exit(1);
}

const region = (cfg.host.match(/email-smtp\.([a-z0-9-]+)\.amazonaws\.com/) || [])[1];
if (region) console.log(`\n  SES region (from host): ${region}  <- identities must be verified HERE`);

const transport = nodemailer.createTransport({
  host: cfg.host, port: cfg.port, secure: cfg.port === 465,
  auth: { user: cfg.user, pass: cfg.pass },
  connectionTimeout: 15000, greetingTimeout: 15000
});

(async () => {
  console.log('\n=== SMTP authentication ===');
  try {
    await transport.verify();
    console.log('  ok   credentials accepted');
  } catch (e) {
    console.log(`  FAIL ${e.message}`);
    console.log('\n  >> Wrong SMTP credentials, or they belong to a different region.');
    console.log('     SES SMTP credentials are region-specific.\n');
    process.exit(1);
  }

  if (!SEND) {
    console.log('\n  Auth works. If mail still is not arriving, the cause shows up only');
    console.log('  on a real send (sender not verified / sandbox recipient rules).');
    console.log('  Re-run with --send to deliver one test message per recipient.\n');
    return;
  }

  console.log('\n=== test sends (one message per recipient) ===');
  const targets = [...new Set([cfg.events, cfg.tracking, cfg.payment])];
  let failed = 0;
  for (const to of targets) {
    try {
      const info = await transport.sendMail({
        from: cfg.from, to,
        subject: '3PL portal - delivery test',
        text: 'Delivery test from the 3PL prep portal. If you received this, portal notifications can reach this address.'
      });
      console.log(`  ok   ${to.padEnd(34)} accepted (${info.messageId || 'queued'})`);
    } catch (e) {
      failed++;
      console.log(`  FAIL ${to.padEnd(34)} ${e.message.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }

  if (failed) {
    console.log('\n  >> "Email address is not verified" means SES is still in SANDBOX:');
    console.log('     every RECIPIENT must be verified individually, and a message is');
    console.log('     rejected in full if any one recipient fails - so an unverified');
    console.log('     thomas@ or accounting@ also stops tanveer@ receiving that mail.');
    console.log('     Verify each address in the region above, or request production access.\n');
  } else {
    console.log('\n  All recipients accepted - check the inboxes (and spam).\n');
  }
})().catch(e => { console.error('mail-check failed:', e.message); process.exit(1); });
