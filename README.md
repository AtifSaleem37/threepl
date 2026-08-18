# 3PL Prep Portal

Lightweight portal for Amazon FBA 3PL prep services. Node.js + Express + SQLite (built-in `node:sqlite`, zero native dependencies). Designed to run on a single small EC2 instance.

## Login URLs

Each role has its own login page: `/admin`, `/clients`, `/accounts`, `/warehouse`. Visiting the URL while logged out shows that role's login form; logins are role-checked (a client account can't log in at `/admin`).

## Flow

1. **Admin** (`/admin`) creates users — **clients** and **staff** (accounts + warehouse) — sets service rates, and can override any payment status. Tabs: Orders, Create Client, Staff Users, Clients & Rates.
2. **Client** (`/clients`, tabs: My Orders & Invoices / New Prep Order) submits a prep order: name, business name, email, brand name, store name, plus one or more **products** (ASIN + quantity, "+" to add more). Receiving, FNSKU labeling and cartonization always apply; **poly bag & bubble wrap** is a per-product option charged for that product's units only.
3. An invoice (PDF, modeled on the VDL sample quote) is generated immediately from the client's effective rates, emailed via SES, and downloadable in the portal.
4. Client sends payment and clicks **Payment sent** → status becomes **Verification in progress**.
5. **Accounts** user (`/accounts`) sees all invoices (client, business, brand, ASINs, totals, invoice PDF) and clicks **Verify payment** (or **Not received**, which reverts to Unpaid).
6. On verification the invoice is **Paid** — shipment status, carrier, and tracking ID unlock on the client's order.
7. Client marks the shipment **shipped** (carrier + tracking ID) → a popup asks for an **FNSKU label PDF per ASIN** (PDF only; re-openable via the "Labels" link). Once shipped + all labels uploaded, the client's shipment fields lock.
8. **Warehouse** user (`/warehouse`) sees shipped orders with full details and FNSKU label downloads, then works the pipeline: **Mark received → Start prep → Mark prep done**.
9. After prep done, warehouse enters **shipment info per ASIN** (text box each) → it appears on the client's portal → client uploads **one or more shipping label PDFs per ASIN** (popup, multi-file) → labels appear on the warehouse portal for download.
10. Once every ASIN has at least one shipping label, warehouse clicks **Mark sent to Amazon** — the final status, visible to the client.

Each portal has a **notification bell** in the header (red dot for unseen items, dropdown panel) showing the last 5 events relevant to it (new orders/payments → admin & accounts; verification, receipt, prep progress, shipment info → client; shipped orders and label uploads → warehouse).

Payment statuses: `Unpaid → Verification in progress → Paid`. Shipment: `pending → shipped → received → prep in progress → prep done → sent to Amazon`. Schema migrations run automatically on boot, so existing databases are upgraded in place.

Sessions are stored per role, so all four portals can be logged in simultaneously in the same browser (different tabs) without kicking each other out. Uploaded FNSKU PDFs live in `data/fnsku/`.

## Billing rules

| Line item | Rate basis | Charged |
|---|---|---|
| Inbound Receiving & Inspection | per unit | always (all units) |
| FBA Prep / FNSKU Labeling | per unit | always (all units) |
| Poly bag & bubble wrap | per unit | **only units of products where selected** |
| Cartonization & Outbound Handling | per carton (cartons = ⌈total quantity ÷ 50⌉) | always |
| Discount % | applied to subtotal | if set |

Rates: admin sets global defaults; per-client overrides win where set (blank = use global). Rates are snapshotted onto each order, so later rate changes don't alter past invoices.

## Run locally

```bash
cp .env.example .env   # edit values
npm install
npm start              # http://localhost:3000
```

Requires **Node >= 22.5** (uses built-in `node:sqlite`). The admin account is seeded on first boot from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

## Deploy on EC2 (minimal cost)

A `t4g.micro` (arm64, ~$6/mo, or free tier `t3.micro`) is plenty. Amazon Linux 2023 or Ubuntu 22.04+.

```bash
# 1. Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# 2. App
git clone <your-repo> ~/threepl && cd ~/threepl
cp .env.example .env && vi .env        # set SESSION_SECRET, admin creds, SES creds
npm install --omit=dev

# 3. systemd
sudo cp deploy/threepl.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now threepl

# 4. Nginx + TLS
sudo cp deploy/nginx.conf /etc/nginx/sites-available/threepl   # edit server_name
sudo ln -s /etc/nginx/sites-available/threepl /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d portal.yourdomain.com
```

Security group: allow 80/443 only (and 22 from your IP). App listens on 127.0.0.1:3000 behind Nginx.

### Email (Amazon SES)

1. Verify your sending domain/address in SES, request production access.
2. Create SMTP credentials (SES console → SMTP settings).
3. Set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` in `.env`.
4. Leave `SMTP_HOST` empty to disable email — invoices stay downloadable in the portal.

### Data & backups

Everything lives in `data/` (SQLite DB + generated invoice PDFs); set `DATA_DIR` to relocate. Back it up with a nightly cron:

```bash
0 3 * * * tar czf /home/ubuntu/backups/threepl-$(date +\%F).tgz -C /home/ubuntu/threepl data
```

## Structure

```
src/server.js    routes (auth, admin, client, invoice download)
src/db.js        schema, seed, rate resolution (global -> per-client)
src/invoice.js   PDF generation (pdfkit)
src/mailer.js    SES SMTP via nodemailer
src/views/       EJS: login, admin, client
public/style.css
deploy/          systemd unit + nginx config
```
