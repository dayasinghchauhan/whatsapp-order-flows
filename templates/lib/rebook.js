/**
 * "Order again" for a COD order that was cancelled because the customer never answered.
 *
 * These are often real buyers who missed the message (busy day, phone off, didn't
 * trust an unknown number). One polite nudge with a link that restores the bag
 * wins some of them back. More than one is spam.
 *
 * WHO gets it, decided by what HAPPENED (events), never by a free-text cancel reason:
 *   ✓ COD order, status 'cancelled', with a 'cod_noreply_alert' (a full day of silence)
 *   ✗ WhatsApp said undeliverable · customer tapped Yes or No · opted out ('STOP')
 *   ✗ the same number ordered again since (a cancelled order doesn't count)
 *   ✗ nothing from the bag still in stock
 *   ✓ only between 24 h and 7 days after the cancel
 *   ✓ ONCE per number, ever (wa_promo_log)
 *
 * The template is MARKETING (Meta will reject it as UTILITY). Until Meta approves
 * it the order just waits: the next run tries again, nothing is marked done.
 */
import { sendTemplate, national, ERR, STOP_RUN } from './wa.js';
import { iso, ago, H, DAY, logEvent, saveMessage, optedOut, parseJson } from './store.js';
import { itemLabel } from './cod.js';

export const REBOOK = { CAMPAIGN: 'rebook', WAIT_H: 24, MAX_DAYS: 7, PER_RUN: 20 };

const firstName = (n) => {
  const w = String(n || '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}][\p{L}.'-]{0,30}$/u.test(w) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : 'there';
};

export async function rebookCandidates(db, now = Date.now()) {
  const { results } = await db.prepare(`
    SELECT o.*, (SELECT MAX(e.created_at) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'cancelled') AS cancelled_at
      FROM orders o
     WHERE o.status = 'cancelled' AND o.payment_method = 'cod'
       AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'cod_noreply_alert')
       AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id
                        AND e.kind IN ('cod_undeliverable', 'cod_confirmed', 'cod_declined', 'rebook_sent', 'rebook_skipped'))
     ORDER BY o.created_at LIMIT 100`).all();
  const lo = ago(now, REBOOK.MAX_DAYS * DAY), hi = ago(now, REBOOK.WAIT_H * H);
  return (results || []).filter((o) => { const t = o.cancelled_at || o.updated_at; return t >= lo && t <= hi; });
}

export async function sweepRebook(env, db, shop, now = Date.now()) {
  const out = [];
  for (const raw of (await rebookCandidates(db, now)).slice(0, REBOOK.PER_RUN)) {
    const o = { ...raw, items: parseJson(raw.items, []) || [] };
    const phone = national(o.phone, env);
    const skip = async (why) => { await logEvent(db, o.id, 'rebook_skipped', 1, why, now); out.push({ id: o.id, skipped: why }); };

    if (!phone || shop.ownPhones.map((p) => national(p, env)).includes(phone)) { await skip('own / invalid number'); continue; }
    if (await optedOut(db, phone)) { await skip('opted out'); continue; }
    if (await db.prepare('SELECT 1 FROM wa_promo_log WHERE campaign = ? AND phone = ?').bind(REBOOK.CAMPAIGN, phone).first()) { await skip('already sent once to this number'); continue; }
    const again = await db.prepare(`SELECT id, phone FROM orders WHERE id != ? AND status != 'cancelled' AND created_at >= ?`).bind(o.id, o.created_at).all();
    if ((again.results || []).some((x) => national(x.phone, env) === phone)) { await skip('ordered again since'); continue; }
    const stock = await shop.inStock(env, db, o.items);
    if (!stock.length) { await skip('nothing in stock'); continue; }

    const r = await sendTemplate(env, { to: phone, name: shop.templates.rebook, lang: shop.templates.lang,
      params: [firstName(o.name), itemLabel(stock)], headerImage: shop.photoFor({ ...o, items: stock }),
      urlButton: { index: 0, suffix: shop.cartSuffix(stock) } });
    if (!r.sent && ERR.TEMPLATE_NOT_READY.has(r.code)) { out.push({ id: o.id, waiting: 'template not approved yet' }); break; }
    if (!r.sent && STOP_RUN.has(r.code)) { out.push({ id: o.id, stopped: 'Meta rate / spam limit ' + r.code }); break; }

    await db.prepare('INSERT OR IGNORE INTO wa_promo_log (campaign, phone, wamid, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(REBOOK.CAMPAIGN, phone, r.msgId || null, r.sent ? 'sent' : 'failed', r.sent ? null : String(r.error).slice(0, 200), iso(now)).run();
    if (r.sent) await saveMessage(db, { wamid: r.msgId, phone, orderId: o.id, kind: 'rebook', template: shop.templates.rebook }, now);
    await logEvent(db, o.id, 'rebook_sent', r.sent, r.sent ? r.msgId : 'refused: ' + r.error, now);
    out.push({ id: o.id, sent: r.sent });
  }
  return out;
}
