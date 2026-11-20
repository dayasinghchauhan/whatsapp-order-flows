---
name: wa-cod-lifecycle
description: Run cash-on-delivery (COD) order handling for an online shop over the WhatsApp Cloud API directly, with no paid tool (BotSailor, Zoko, CampaignHQ). It covers the COD confirm/cancel buttons, address check before booking the courier, location pin, the 6 h reminder and 24 h owner alert, undeliverable-number handling, a one-time "order again" message for silent cancellations, and abandoned-checkout reminders with a frequency cap. Built for Indian D2C shops (high COD, high RTO) on Cloudflare Pages/Workers + D1; the logic is plain JS. Use it when someone asks to reduce RTO, confirm COD orders on WhatsApp, recover abandoned carts on WhatsApp, or replace a WhatsApp automation SaaS. Do not use it for WhatsApp chatbots, broadcast campaigns or customer support inboxes.
license: MIT
---

# wa-cod-lifecycle

In India a large share of online orders are COD, and many come back
undelivered (RTO): the buyer changed their mind, the address was unfindable, the
number was fake. Every RTO costs two-way shipping. Most of it is avoidable if
you **ask before you ship** and **fix the address before the courier sees it**.

```
 checkout ─► order (COD, status 'pending', no courier)
               │ startCod()
               ├─ weak address? ─► [address_confirm]  Address is correct │ Change address
               │                        │ correct            │ typed reply → parsed + saved, or → owner
               ▼                        ▼                    ▼
           [cod_order_confirm]  photo · item · total · address
               ├─ Yes ─► 'confirmed' ─► shop.book() ─► "confirmed" text      (weak address → location pin first)
               ├─ No  ─► 'cancelled' ─► shop.cancel() (restock) ─► text
               ├─ 131026 undeliverable ─► owner: "call them" (now, not in 6 h)
               └─ silence ─► 6 h reminder ─► 24 h owner alert ─► owner cancels
                                                                    │ 24 h–7 d later, once per number ever
                                                                    ▼
                                                              [order_rebook]  link restores the bag (in-stock items only)

 payment window opened, never paid ─► checkout_attempts ─► wait 15/30/60 min ─► [bag_reminder]  max 2 / 7 days, 24 h apart
```

## Workflow

### 1. Read the shop first
- Order model: where orders are saved, the status values, how COD is marked, where the courier gets booked (that becomes `shop.book`), and what restocks a cancelled order (`shop.cancel`).
- Map their status values to the three used here: `pending` (COD waiting), `confirmed`, `cancelled`. Use a mapping, or add a column. Don't silently rename statuses the admin depends on.
- Find what the checkout knows when the payment window opens / fails / closes (Razorpay `modal.ondismiss`, `payment.failed`). That feeds `recordAttempt`.
- Find the WhatsApp setup: is a WABA connected, is a **permanent system-user token** available, and is there a webhook URL already? Meta allows **one** webhook URL per app. If another tool already uses it, stop and ask.

### 2. Templates (submit first: approval takes minutes to days)
Submit the 4 templates in `references/meta-templates.md`, **with the categories given there**. Meta re-categorises a "reminder" or "come back" message to MARKETING, and a wrong category gets the template rejected or changed. Image headers must be JPG/PNG (WebP is refused). Nothing below needs them approved to be built and tested (`WA_MOCK=true`).

### 3. Install
- Copy `templates/lib/*`, `templates/config.js`, `templates/functions/api/webhooks/whatsapp.js` and `templates/functions/api/cron/wa-sweep.js`. Run `templates/schema.sql` (it uses `CREATE TABLE IF NOT EXISTS`. If they already have an `orders` table, add only the missing columns).
- Fill in `config.js`: template names, `ownPhones`, `photoFor`, `addressWeak` (their courier's real rule), `book`, `cancel`, `inStock`, `cartSuffix` (needs a cart-restore URL on the site, e.g. `/cart?restore=SKU-QTY,SKU-QTY`), and `alertOwner`.
- Call `startCod(env, db, shop, orderId)` right after a COD order is saved, in `waitUntil`, so checkout never waits on WhatsApp.
- Call `recordAttempt(db, {...})` on window open / fail / dismiss.
- Secrets: `WA_PHONE_ID`, `WA_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `CRON_KEY`, `OWNER_WEBHOOK`. Var `WA_MOCK=true` on staging.
- Meta app → WhatsApp → Configuration → webhook URL `https://SITE/api/webhooks/whatsapp`, verify token = `WA_VERIFY_TOKEN`. Subscribe to `messages`.
- Every 30 min: `GET /api/cron/wa-sweep` with `x-cron-key` (cron-job.org, a scheduled Worker, or GitHub Actions).

### 4. Verify
- `npm test` → 16 scenario tests (Node ≥ 22.13).
- Staging with `WA_MOCK=true`: place a COD order, then check `order_events` (`cod_question_sent`) and `wa_messages`.
- Live, with the owner's own phone (not in `ownPhones` for this test): one order each for Yes, No, and a weak address → Change address → typed reply. Check the status, the courier booking, the restock, and that the owner alert has **no phone number**.
- Report to the user what was tested live and what only in mock.

## Rules that matter
1. **A tap acts only from the order's own number, only while the order is waiting, only once.** Status changes are compare-and-set (`WHERE status = 'pending'`).
2. **Address before COD question.** A "Yes" on an address the courier can't find still comes back as RTO.
3. **Free text only inside 24 h** of the customer's last message or tap (`131047` otherwise). Anything later must be a template.
4. **Undeliverable (`131026`) = call now.** Don't wait for a reminder that will fail the same way.
5. **Never auto-cancel by default.** Silence goes to the owner after 24 h. Many silent buyers do answer a phone call.
6. **"Order again" once per number, ever**, chosen by events (what happened), never by a typed cancel reason. Only in-stock items, only 24 h–7 d after the cancel, never after "STOP".
7. **Bag reminder: 2 per 7 days, 24 h apart, newest try only, never if they ordered since** (a cancelled order doesn't count). A Meta-refused send (`131049`) counts for the 24 h gap but not for the cap of 2.
8. **Template not approved yet = wait.** Never mark a job done because the template wasn't ready (`132000/132001/132005/132007/132015/132016`). Stop the run on rate/spam limits (`130429/131048`).
9. **No customer phone numbers in Discord/Slack.** Use name and order id. The number stays in your admin (GDPR / India DPDP Act data minimisation).
10. **Verify `X-Hub-Signature-256`** on every webhook. Answer 200 even when you ignore a body, so Meta doesn't retry it.

## Files
| Path | What |
|---|---|
| `templates/lib/wa.js` | Cloud API: template (image header, quick-reply payloads, URL button), text, location request, signature check, error codes |
| `templates/lib/cod.js` | State machine: `startCod`, `handleButton`, `handleText` (address reply, STOP), `handleLocation`, `handleStatuses`, `sweepCod` |
| `templates/lib/rebook.js` | `sweepRebook`: one "order again" per number |
| `templates/lib/abandon.js` | `recordAttempt`, `sweepAbandoned` |
| `templates/lib/store.js` | Event log, message log, opt-out |
| `templates/config.js` | All shop-specific hooks |
| `templates/functions/api/webhooks/whatsapp.js` | Webhook (verify + signed POST + dispatch) |
| `templates/functions/api/cron/wa-sweep.js` | 30-min sweep endpoint |
| `templates/schema.sql` | Tables |
| `references/meta-templates.md` | Template text, categories and buttons to submit |
| `references/rules.md` | Why each rule exists, error-code table, costs |
| `tests/` | 16 tests on an in-memory SQLite D1 stand-in |
