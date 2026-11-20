-- whatsapp-order-flows tables.  wrangler d1 execute <DB> --remote --file templates/schema.sql
--
-- `orders` is YOUR table. These columns are what the templates read; map names
-- in config.js if yours differ. Status values used here:
--   pending    COD placed, waiting for the customer's WhatsApp answer (no courier yet)
--   confirmed  customer tapped Yes (or prepaid) → hand to the courier
--   cancelled  customer tapped No, or the owner cancelled
CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  phone          TEXT,
  items          TEXT,      -- JSON [{ "sku": "...", "name": "...", "qty": 1, "price": 49900 }]
  total          INTEGER,   -- smallest currency unit (paise / cents)
  address        TEXT,      -- JSON { "line1", "line2", "landmark", "city", "state", "pin" }
  payment_method TEXT,      -- 'cod' | 'prepaid'
  status         TEXT,
  awb            TEXT,      -- courier tracking number once booked
  created_at     TEXT,
  updated_at     TEXT
);

-- Every step is an event: idempotency, audit trail and the sweep's memory.
CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- cod_question_sent, cod_reminder_sent, cod_confirmed, cod_declined, cod_noreply_alert,
                              -- cod_undeliverable, cod_held, address_question_sent, address_ok, address_change_requested,
                              -- address_saved, location_received, cancelled, rebook_sent, rebook_skipped, ...
  ok         INTEGER,
  detail     TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS order_events_order ON order_events (order_id, kind);

-- Every message we sent, so delivery receipts (sent → delivered → read / failed) land somewhere.
CREATE TABLE IF NOT EXISTS wa_messages (
  wamid      TEXT PRIMARY KEY,
  phone      TEXT,
  order_id   TEXT,
  attempt_id TEXT,
  kind       TEXT,           -- cod_question | address_question | rebook | bag_reminder | text
  template   TEXT,
  status     TEXT,
  error_code INTEGER,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS wa_messages_phone ON wa_messages (phone, kind, created_at);

-- "STOP" replies. Marketing (rebook, bag reminder) never goes to 'out'.
CREATE TABLE IF NOT EXISTS wa_optin (phone TEXT PRIMARY KEY, status TEXT, updated_at TEXT);

-- One-per-number-ever campaigns (order again).
CREATE TABLE IF NOT EXISTS wa_promo_log (
  campaign TEXT NOT NULL, phone TEXT NOT NULL, wamid TEXT, status TEXT, error TEXT, created_at TEXT,
  PRIMARY KEY (campaign, phone)
);

-- One row per checkout try (payment window opened). Written by your checkout.
CREATE TABLE IF NOT EXISTS checkout_attempts (
  id         TEXT PRIMARY KEY,   -- e.g. the payment gateway's order id
  phone      TEXT,
  name       TEXT,
  items      TEXT,               -- JSON, same shape as orders.items
  total      INTEGER,
  status     TEXT,               -- started | failed (bank declined) | dismissed (closed the window)
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS checkout_attempts_phone ON checkout_attempts (phone, created_at);
