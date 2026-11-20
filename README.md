# whatsapp-order-flows

[![tests](https://github.com/dayasinghchauhan/whatsapp-order-flows/actions/workflows/test.yml/badge.svg)](https://github.com/dayasinghchauhan/whatsapp-order-flows/actions/workflows/test.yml)
![license](https://img.shields.io/badge/license-MIT-blue)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

**A Claude Code skill that automates an online shop's order messages over the WhatsApp Cloud API directly. No
BotSailor, Zoko or CampaignHQ subscription.**

Four flows (abandoned checkout works on its own; order again builds on COD confirmation):

1. **COD confirmation**: Yes / No buttons before the courier is booked.
2. **Address check**: a weak address is fixed on WhatsApp (typed reply or location pin) before shipping.
3. **Order again**: one message, once per number, after a COD order is cancelled for no answer.
4. **Abandoned checkout**: "you left X in your bag", at most 2 per week, never after they ordered.

Built for Indian D2C shops, where a large share of orders are COD and many come back undelivered (RTO).
Every RTO costs two-way shipping. Most of it is avoidable if you **ask before you ship** and **fix the
address before the courier sees it**.

| Flow | What happens |
|---|---|
| **COD confirmation** | Template with product photo, total and full address: **Yes, confirm order** / **No, cancel order**. Yes → courier booked. No → cancelled and restocked. |
| **Address first** | A weak address (just a street name, no house number) gets **Address is correct** / **Change address** *before* the COD question. A typed reply is parsed and saved, or sent to the owner. |
| **Location pin** | "Yes" on a still-weak address → WhatsApp's *Send location* button. |
| **Silence** | One reminder at 6 h, an owner alert ("call them") at 24 h. Never auto-cancelled by default. |
| **Not on WhatsApp** | Error 131026 → owner told **now**, not after a reminder that would fail too. |
| **Order again** | A COD order cancelled after a full day of silence → **one** message, 24 h–7 d later, once per number ever, in-stock items only, with a link that restores the bag. |
| **Abandoned checkout** | Payment window opened but never paid → "you left X in your bag", max **2 per 7 days, 24 h apart**, and never if they ordered since. |
| **Warm buyer** | 3rd checkout try in 7 days → owner alert (name + bag, no phone number). |
| **STOP** | Opt-out from marketing. Order updates still go. |

Plain JavaScript, no dependencies. Templates target Cloudflare Pages Functions + D1; the logic ports to any
runtime with SQL and `fetch`. 16 tests.

---

## How it works

```
 checkout ─► order (COD, status 'pending', no courier)
               │ startCod()
               ├─ weak address? ─► [address_confirm]  Address is correct │ Change address
               │                        │ correct            │ typed reply → parsed + saved, or → owner
               ▼                        ▼                    ▼
           [cod_order_confirm]  photo · item · total · address
               ├─ Yes ─► 'confirmed' ─► shop.book() ─► "confirmed" text      (weak address → location pin first)
               ├─ No  ─► 'cancelled' ─► shop.cancel() (restock) ─► text
               ├─ 131026 undeliverable ─► owner: "call them" (now)
               └─ silence ─► 6 h reminder ─► 24 h owner alert ─► owner cancels
                                                                    │ 24 h–7 d later, once per number ever
                                                                    ▼
                                                              [order_rebook]  link restores the bag

 payment window opened, never paid ─► checkout_attempts ─► wait 15/30/60 min ─► [bag_reminder]  max 2 / 7 days
```

Every step writes an `order_events` row. That gives you an audit trail, idempotency (a double tap or a Meta
retry does nothing), and the sweep's memory.

## Install as a Claude Code skill

```bash
git clone https://github.com/dayasinghchauhan/whatsapp-order-flows ~/.claude/skills/whatsapp-order-flows
```

Then ask Claude, for example:
- *"Confirm COD orders on WhatsApp before we book the courier."*
- *"Our RTO is too high. Add an address check and COD confirmation on WhatsApp."*
- *"Send abandoned-cart reminders on WhatsApp without spamming people."*

The skill makes Claude map your order statuses, courier booking and restock code into one `config.js`,
submit the right Meta templates with the right categories, install the webhook and the 30-min sweep, and test
with `WA_MOCK=true` before going live.

## Manual setup (without Claude)

<details>
<summary><b>1. Meta templates (submit first: review takes minutes to days)</b></summary>

| Template | Category | Buttons |
|---|---|---|
| `cod_order_confirm` | UTILITY | Quick reply: `Yes, confirm order` · `No, cancel order` |
| `address_confirm` | UTILITY | Quick reply: `Address is correct` · `Change address` |
| `order_rebook` | MARKETING | URL (dynamic): `https://<site>/cart?restore={{1}}` |
| `bag_reminder_v2` (+ keep `bag_reminder`) | MARKETING | URL (dynamic) |

Full text, variable order and approval tips: [`references/meta-templates.md`](references/meta-templates.md).
Image headers must be JPG/PNG. WhatsApp refuses WebP.
</details>

<details>
<summary><b>2. Files and tables</b></summary>

Copy `templates/lib/*`, `templates/config.js`, `templates/functions/api/webhooks/whatsapp.js` and
`templates/functions/api/cron/wa-sweep.js` into your project. Run `templates/schema.sql`. If you already
have an `orders` table, add only the missing columns.

Your `orders` table needs: `id, name, phone, items (JSON), total (paise), address (JSON), payment_method,
status, awb, created_at, updated_at`. Statuses used: `pending` (COD waiting) → `confirmed` / `cancelled`.
</details>

<details>
<summary><b>3. config.js: your shop's hooks</b></summary>

| Hook | What you return |
|---|---|
| `templates` | approved template names + language |
| `ownPhones` | owner / staff / test numbers: never messaged automatically |
| `photoFor(order)` | a JPG/PNG URL for the image header |
| `addressWeak(order)` | `''` if fine, otherwise a reason (your courier's real rule) |
| `book(env, db, order)` | `{ ok, awb }`: book the courier |
| `cancel(env, db, order, reason)` | restock etc. |
| `inStock(env, db, items)` | items still buyable (for "order again") |
| `cartSuffix(items)` | the URL button suffix that restores the bag |
| `alertOwner(env, title, body)` | Discord / Slack / push. **Never put the customer's phone number in it** |
</details>

<details>
<summary><b>4. Wire it</b></summary>

```js
// after a COD order is saved (status 'pending'): don't make checkout wait on WhatsApp
context.waitUntil(startCod(env, env.DB, shop, orderId));

// your checkout: payment window opened / failed / closed
await recordAttempt(env.DB, { id: gatewayOrderId, phone, name, items, total, status: 'started' }, env);
```

| Env | Meaning |
|---|---|
| `WA_PHONE_ID` | phone number ID (WhatsApp Manager → API setup) |
| `WA_TOKEN` *(secret)* | system-user **permanent** token (`whatsapp_business_messaging`) |
| `WA_APP_SECRET` *(secret)* | for `X-Hub-Signature-256` |
| `WA_VERIFY_TOKEN` *(secret)* | webhook verification |
| `WA_COUNTRY_CODE` / `WA_PHONE_DIGITS` | default `91` / `10` |
| `WA_MOCK` | `true` on staging: nothing is sent |
| `CRON_KEY` *(secret)* | for `/api/cron/wa-sweep` |
| `OWNER_WEBHOOK` *(secret)* | owner alerts |

- Meta app → WhatsApp → Configuration → webhook `https://<site>/api/webhooks/whatsapp`, subscribe to `messages`.
  Meta allows **one** webhook URL per app. If another tool already uses it, decide before switching.
- Every 30 min: `GET /api/cron/wa-sweep` with header `x-cron-key` (cron-job.org, a scheduled Worker or GitHub Actions).
</details>

---

## Rules (and the failure each one prevents)

| Rule | Why |
|---|---|
| A tap acts only from the **order's own number**, only while waiting, only once | Forwarded messages, family phones, double taps, Meta retries |
| **Address before the COD question** | A "Yes" on an address with no house number can still come back as RTO |
| Show the **full** address | A shortened address gets confirmed without the customer seeing all of it |
| Keep city/state/PIN from checkout; a different PIN goes to the owner | Those decided the courier and the COD fee |
| 131026 → owner **now** | Waiting 6 h for a reminder that fails the same way loses a day |
| **No auto-cancel** by default | Many silent buyers answer a phone call |
| "Order again" chosen by **events**, not cancel-reason text | Owners type "cust not responding", "no reply"… |
| Once per number **ever** | A second one is spam and lowers your number's quality rating |
| Bag reminder waits 15 / 30 / 60 min | A shopper retrying UPI shouldn't be interrupted |
| A **cancelled** order doesn't block the bag reminder | The bag is open again |
| 2nd reminder allowed after a **new** try | Coming back after the first message = more interested |
| A Meta-refused send (131049) doesn't count toward the cap, does count for the 24 h gap | Otherwise one refused send blocks an interested buyer for a week, or gets retried every 30 min |
| Template not approved yet = **wait** | Marking jobs done on 132001 silently drops every customer from that period |
| Verify `X-Hub-Signature-256`, answer 200 even when ignoring | Unsigned bodies must not write; non-200 makes Meta retry for days |
| No phone numbers in Discord/Slack | Third-party processors. DPDP Act / GDPR minimisation |

Error-code table and costs: [`references/rules.md`](references/rules.md).

## Tests

Node ≥ 22.13, no `npm install`. An in-memory SQLite D1 stand-in plus a mocked Graph API.

```bash
npm test
```
Covered: COD question payloads + photo header · never asked twice · address-first then release · Yes →
confirmed + booked once, duplicate and wrong-phone taps ignored · No → cancelled + restock + one reply,
late taps answered once · 6 h reminder / 24 h owner alert / no auto-cancel · 131026 → owner now ·
"Change address" typed reply saved and parser edge cases · STOP · rebook after 24 h, once per number,
"ordered again" skip, waits while the template is in review · abandoned: wait times, newest try, own
number, cancelled-order rule, 2-per-7-days cap with the 131049 gap rule, warm-buyer alert, template
fallback · webhook verify + signature.

## Repository layout

```
SKILL.md                                    what Claude reads
templates/config.js                         your shop's hooks
templates/lib/wa.js                         Cloud API: template, text, location, signature, error codes
templates/lib/cod.js                        COD state machine + sweep
templates/lib/rebook.js                     order again
templates/lib/abandon.js                    abandoned checkout
templates/lib/store.js                      event / message / opt-out helpers
templates/functions/api/webhooks/whatsapp.js
templates/functions/api/cron/wa-sweep.js
templates/schema.sql
references/meta-templates.md                template text + categories
references/rules.md                         why each rule, error codes, costs
tests/
```

## Outside India

Set `WA_COUNTRY_CODE`, `WA_PHONE_DIGITS`, `COD.POSTCODE` (in `lib/cod.js`) and `addressWeak` for your
country's address format. Everything else is country-neutral.

## Limits

- Not a chatbot, broadcast tool or support inbox. Free-text messages go to the owner.
- Courier booking, restock and the cart-restore page are **your** code (hooks in `config.js`).
- Meta pricing and error codes change. Check the current docs.

## Related
- [serverless-soc](https://github.com/dayasinghchauhan/serverless-soc): uptime, storage watchdog, security monitoring (SOC) and honeytokens for the same kind of shop on Cloudflare.

## License

MIT
