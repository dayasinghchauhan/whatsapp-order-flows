/**
 * Abandoned checkout ("you left X in your bag") on WhatsApp.
 *
 * Your checkout writes one row per payment try (checkout_attempts):
 *   'started'   payment window opened        (create-order endpoint)
 *   'failed'    bank / UPI declined          (gateway callback or webhook)
 *   'dismissed' shopper closed the window    (gateway's modal.ondismiss)
 * A try that was never paid leaves NO order, so without this nobody knows.
 *
 * Rules:
 *   - wait first: failed 15 min, dismissed 30 min, no signal 60 min,
 *     so someone still retrying is not interrupted;
 *   - never when that number has ordered since the try (a CANCELLED order doesn't count,
 *     so a cancelled COD reopens the reminder);
 *   - only the newest try per number, never one older than 24 h;
 *   - at most 2 per number per 7 days, 24 h apart. A shopper who comes back AFTER
 *     the first message is MORE interested, so a new try gets a second one.
 *     Only messages Meta accepted and did not fail count toward the 2 (a 131049
 *     "not delivered" must not block the number for a week), but EVERY send counts
 *     for the 24 h gap (so a 131049 number is not retried at once);
 *   - the shop's own numbers never get one;
 *   - opted-out numbers never get one (it's marketing);
 *   - 3rd try in 7 days = a warm buyer: alert the owner (name + bag, no number), once a day;
 *   - template fallback: newest approved template first; while it is in review, the
 *     previous one goes; if none is approved the try simply waits.
 */
import { sendTemplate, national, ERR, STOP_RUN } from './wa.js';
import { iso, ago, H, MIN, DAY, saveMessage, optedOut, parseJson } from './store.js';
import { itemLabel } from './cod.js';

export const ABANDON = {
  WAIT_MIN: { failed: 15, dismissed: 30, started: 60 },
  MAX_AGE_H: 24,
  PER_PHONE: 2,
  PER_PHONE_DAYS: 7,
  GAP_H: 24,
  WARM_TRIES: 3,
  PER_RUN: 30,
};

/** Called by your checkout. status: started | failed | dismissed */
export async function recordAttempt(db, { id, phone, name, items, total, status = 'started' }, env = {}, now = Date.now()) {
  await db.prepare(`INSERT INTO checkout_attempts (id, phone, name, items, total, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`)
    .bind(String(id), national(phone, env), name || '', JSON.stringify(items || []), Number(total) || 0, status, iso(now), iso(now)).run();
}

export async function sweepAbandoned(env, db, shop, now = Date.now()) {
  const own = new Set(shop.ownPhones.map((p) => national(p, env)));
  const { results } = await db.prepare(`SELECT * FROM checkout_attempts WHERE status IN ('started','failed','dismissed') AND created_at >= ? ORDER BY created_at DESC`)
    .bind(ago(now, ABANDON.MAX_AGE_H * H)).all();
  const newest = new Map();
  for (const a of results || []) if (a.phone && !newest.has(a.phone)) newest.set(a.phone, a);   // DESC: first = newest

  const out = [];
  for (const a of [...newest.values()].slice(0, ABANDON.PER_RUN)) {
    const res = { id: a.id };
    out.push(res);
    if (own.has(a.phone)) { res.skip = 'own number'; continue; }
    const waitMin = ABANDON.WAIT_MIN[a.status] ?? 60;
    if (iso(now - waitMin * MIN) < (a.updated_at || a.created_at)) { res.skip = 'too early'; continue; }
    if (await optedOut(db, a.phone)) { res.skip = 'opted out'; continue; }
    if (await db.prepare('SELECT 1 FROM wa_messages WHERE attempt_id = ?').bind(a.id).first()) { res.skip = 'already messaged for this try'; continue; }

    const ordered = await db.prepare(`SELECT id, phone FROM orders WHERE status != 'cancelled' AND created_at >= ?`).bind(a.created_at).all();
    if ((ordered.results || []).some((o) => national(o.phone, env) === a.phone)) { res.skip = 'ordered since'; continue; }

    const sends = (await db.prepare(`SELECT status, created_at FROM wa_messages WHERE phone = ? AND kind = 'bag_reminder' AND created_at >= ? ORDER BY created_at DESC`)
      .bind(a.phone, ago(now, ABANDON.PER_PHONE_DAYS * DAY)).all()).results || [];
    if (sends[0] && sends[0].created_at > ago(now, ABANDON.GAP_H * H)) { res.skip = 'last message < 24 h ago'; continue; }
    if (sends.filter((s) => s.status !== 'failed').length >= ABANDON.PER_PHONE) { res.skip = 'cap: 2 in 7 days'; continue; }

    // Warm buyer: 3rd try in 7 days → tell the owner (once a day), without the number.
    const tries = await db.prepare('SELECT COUNT(*) n FROM checkout_attempts WHERE phone = ? AND created_at >= ?').bind(a.phone, ago(now, 7 * DAY)).first('n');
    if (tries >= ABANDON.WARM_TRIES) {
      const key = 'warm|' + a.phone + '|' + iso(now).slice(0, 10);
      const r = await db.prepare('INSERT OR IGNORE INTO wa_promo_log (campaign, phone, status, created_at) VALUES (?, ?, ?, ?)').bind('warm_alert', key, 'sent', iso(now)).run();
      if (r.meta.changes) await shop.alertOwner(env, 'Warm buyer: ' + tries + ' checkout tries in 7 days', (a.name || 'Customer') + ' - ' + itemLabel(parseJson(a.items, [])) + '. Open the abandoned-checkout list in your admin.');
    }

    const items = parseJson(a.items, []) || [];
    let r = null, used = null;
    for (const t of shop.templates.bagReminder) {
      r = await sendTemplate(env, { to: a.phone, name: t, lang: shop.templates.lang, params: [(a.name || 'there').split(' ')[0], itemLabel(items)],
        headerImage: shop.photoFor({ items }), urlButton: { index: 0, suffix: shop.cartSuffix(items) } });
      used = t;
      if (r.sent || !ERR.TEMPLATE_NOT_READY.has(r.code)) break;
    }
    if (!r.sent && ERR.TEMPLATE_NOT_READY.has(r.code)) { res.waiting = 'no approved template yet'; break; }
    if (!r.sent && STOP_RUN.has(r.code)) { res.stopped = 'Meta limit ' + r.code; break; }
    // Record the try even when Meta refused (gap rule); a refused one is 'failed' and doesn't count toward the cap.
    await saveMessage(db, { wamid: r.msgId || 'refused-' + a.id + '-' + now, phone: a.phone, attemptId: a.id, kind: 'bag_reminder', template: used,
      status: r.sent ? 'sent' : 'failed', errorCode: r.code || null }, now);
    res.sent = !!r.sent; res.template = used;
  }
  return out;
}
