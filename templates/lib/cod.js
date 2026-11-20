/**
 * COD confirmation on WhatsApp: the state machine.
 *
 *   order placed (COD, status 'pending', no courier)
 *     │ startCod()
 *     ├─ address weak? ──► address_confirm [Address is correct | Change address]
 *     │                       ├─ correct ───────────────┐
 *     │                       └─ change → customer types → saved if it parses, else owner
 *     ▼                                                  ▼
 *   cod_order_confirm [Yes, confirm order | No, cancel order]   (photo header, total, address)
 *     ├─ Yes → status 'confirmed' → shop.book() → thank-you text
 *     ├─ No  → status 'cancelled' → shop.cancel() (restock) → text
 *     ├─ WhatsApp says undeliverable (131026) → owner alert now: call them
 *     └─ silence: 6 h → one reminder · 24 h → owner alert ("call them") · optional auto-cancel
 *
 * Safety rules: a button acts only when it comes from the ORDER'S OWN number,
 * only while the order is still waiting, and only once (events = idempotency).
 * Status changes are compare-and-set (WHERE status = 'pending').
 */
import { sendTemplate, sendText, sendLocationRequest, national, ERR } from './wa.js';
import { iso, ago, H, logEvent, lastEvent, hasEvent, saveMessage, parseJson, setOptin } from './store.js';

export const COD = {
  REMIND_AFTER_H: 6,
  OWNER_ALERT_AFTER_H: 24,
  AUTO_CANCEL_AFTER_H: 0,          // 0 = never: the owner decides after calling
  ADDRESS_REPLY_WINDOW_H: 48,
  PAYLOAD: /^(CODY|CODN|ADRY|ADRN)\|([A-Za-z0-9_-]{3,40})$/,
  POSTCODE: /\b\d{6}\b/g,          // India PIN; change for other countries
};

const isCod = (o) => String(o.payment_method) === 'cod';
const waiting = (o) => String(o.status) === 'pending' && !String(o.awb || '').trim();

export async function loadOrder(db, id) {
  const o = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(String(id)).first();
  if (!o) return null;
  return { ...o, items: parseJson(o.items, []) || [], address: parseJson(o.address, {}) || {} };
}

const money = (shop, paise) => shop.currency + Math.round((Number(paise) || 0) / 100).toLocaleString('en-IN');
export function itemLabel(items) {
  if (!items.length) return 'your order';
  const first = String(items[0].name || 'your order').replace(/\s+/g, ' ').trim().slice(0, 60);
  return items.length > 1 ? first + ' + ' + (items.length - 1) + ' more' : first;
}
const addrLine = (a) => [a.line1, a.line2, a.landmark, a.city, a.state, a.pin].filter((x) => String(x || '').trim()).join(', ');

async function setStatus(db, id, from, to, now) {
  const r = await db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?').bind(to, iso(now), String(id), from).run();
  return !!(r && r.meta && r.meta.changes);
}

// ----------------------------------------------------------------- questions

export async function sendCodQuestion(env, db, shop, o, by = 'auto', now = Date.now()) {
  const params = [o.name || 'Customer', o.id, itemLabel(o.items), money(shop, o.total), addrLine(o.address) || 'your address'];
  const r = await sendTemplate(env, { to: o.phone, name: shop.templates.codQuestion, lang: shop.templates.lang, params,
    headerImage: shop.photoFor(o), payloads: ['CODY|' + o.id, 'CODN|' + o.id] });
  if (r.sent) await saveMessage(db, { wamid: r.msgId, phone: national(o.phone, env), orderId: o.id, kind: 'cod_question', template: shop.templates.codQuestion }, now);
  await logEvent(db, o.id, by === 'reminder' ? 'cod_reminder_sent' : 'cod_question_sent', r.sent, r.sent ? 'msg ' + r.msgId + ' (' + by + ')' : 'not sent: ' + r.error, now);
  return r;
}

export async function sendAddressQuestion(env, db, shop, o, by = 'auto', now = Date.now()) {
  const params = [o.name || 'Customer', o.id, addrLine(o.address) || 'your address'];
  const r = await sendTemplate(env, { to: o.phone, name: shop.templates.addressQuestion, lang: shop.templates.lang, params,
    headerImage: shop.photoFor(o), payloads: ['ADRY|' + o.id, 'ADRN|' + o.id] });
  if (r.sent) await saveMessage(db, { wamid: r.msgId, phone: national(o.phone, env), orderId: o.id, kind: 'address_question', template: shop.templates.addressQuestion }, now);
  await logEvent(db, o.id, 'address_question_sent', r.sent, r.sent ? 'msg ' + r.msgId + ' (' + by + ')' : 'not sent: ' + r.error, now);
  return r;
}

/** Call once right after a COD order is saved (status 'pending'). Never throws. */
export async function startCod(env, db, shop, orderId, now = Date.now()) {
  try {
    const o = await loadOrder(db, orderId);
    if (!o || !isCod(o) || !waiting(o)) return { skipped: 'not a waiting COD order' };
    if (await hasEvent(db, o.id, ['cod_question_sent', 'cod_held'])) return { skipped: 'already asked' };
    const weak = shop.addressWeak(o);
    if (weak) {
      // Address FIRST: a "Yes" on an address the courier cannot find is a parcel coming back (RTO).
      const ar = await sendAddressQuestion(env, db, shop, o, 'auto', now);
      if (ar.sent) { await logEvent(db, o.id, 'cod_held', 1, 'COD question waits for the address: ' + weak, now); return { held: weak, ...ar }; }
    }
    return await sendCodQuestion(env, db, shop, o, 'auto', now);
  } catch (e) { return { sent: false, error: String((e && e.message) || e) }; }
}

async function releaseHeld(env, db, shop, o, now) {
  if (!(await hasEvent(db, o.id, ['cod_held']))) return null;
  if (await hasEvent(db, o.id, ['cod_question_sent', 'cod_confirmed', 'cod_declined'])) return null;
  return sendCodQuestion(env, db, shop, o, 'after_address', now);
}

// ------------------------------------------------------------- button replies

/** A quick-reply tap. `from` = the sender's number as WhatsApp gives it. */
export async function handleButton(env, db, shop, { from, payload }, now = Date.now()) {
  const m = COD.PAYLOAD.exec(String(payload || ''));
  if (!m) return { handled: false };
  const [, kind, id] = m;
  const o = await loadOrder(db, id);
  if (!o) return { handled: true, ignored: 'unknown order' };
  const sender = national(from, env);
  if (national(o.phone, env) !== sender) {
    await logEvent(db, o.id, 'button_wrong_phone', 0, kind + ' from a different number - ignored', now);
    return { handled: true, ignored: 'wrong phone' };
  }
  if (!waiting(o)) {
    if (!(await hasEvent(db, o.id, ['late_tap_answered']))) {
      await sendText(env, o.phone, 'Order ' + o.id + ' is already ' + (o.status === 'cancelled' ? 'cancelled' : 'being processed') + '. Write here if you need help.');
      await logEvent(db, o.id, 'late_tap_answered', 1, kind, now);
    }
    return { handled: true, ignored: 'not waiting (' + o.status + ')' };
  }

  if (kind === 'CODY') {
    if (await hasEvent(db, o.id, ['cod_confirmed'])) return { handled: true, ignored: 'duplicate' };
    await logEvent(db, o.id, 'cod_confirmed', 1, 'customer tapped Yes', now);
    const weak = shop.addressWeak(o);
    if (weak) {
      // The tap opened the 24 h window: ask for the location pin with a free-form button.
      await sendLocationRequest(env, o.phone, 'Thank you! To deliver order ' + o.id + ', please tap "Send location" and share your delivery location, then type your house / flat number here.');
      await shop.alertOwner(env, 'COD confirmed, address still weak - ' + o.id, (o.name || 'Customer') + ' said Yes. Address: ' + weak + '. Location asked; book once it arrives.');
      return { handled: true, action: 'confirmed_wait_address' };
    }
    if (!(await setStatus(db, o.id, 'pending', 'confirmed', now))) return { handled: true, ignored: 'race: status changed' };
    const b = await shop.book(env, db, { ...o, status: 'confirmed' }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    await logEvent(db, o.id, 'booked', b.ok, b.ok ? 'awb ' + (b.awb || '') : 'book failed: ' + b.error, now);
    if (!b.ok) await shop.alertOwner(env, 'Courier booking failed - ' + o.id, 'Customer confirmed COD but booking failed: ' + b.error + '. Book it by hand.');
    await sendText(env, o.phone, 'Thank you, ' + (o.name || '').split(' ')[0] + '! Order ' + o.id + ' is confirmed. We will send the tracking link as soon as it ships.');
    return { handled: true, action: 'confirmed', booked: !!b.ok };
  }

  if (kind === 'CODN') {
    if (!(await setStatus(db, o.id, 'pending', 'cancelled', now))) return { handled: true, ignored: 'race: status changed' };
    await logEvent(db, o.id, 'cod_declined', 1, 'customer tapped No', now);
    await logEvent(db, o.id, 'cancelled', 1, 'by customer (WhatsApp)', now);
    await shop.cancel(env, db, { ...o, status: 'cancelled' }, 'customer declined COD').catch(() => null);
    await sendText(env, o.phone, 'Order ' + o.id + ' is cancelled. Nothing to pay. If that was a mistake, just order again on ' + shop.site + '.');
    return { handled: true, action: 'cancelled' };
  }

  if (kind === 'ADRY') {
    await logEvent(db, o.id, 'address_ok', 1, 'customer: address is correct', now);
    const r = await releaseHeld(env, db, shop, o, now);
    if (!r) await sendText(env, o.phone, 'Thank you! We will deliver order ' + o.id + ' to that address.');
    return { handled: true, action: 'address_ok', codAsked: !!(r && r.sent) };
  }

  // ADRN
  await logEvent(db, o.id, 'address_change_requested', 1, 'customer: change address', now);
  await sendText(env, o.phone, 'Please type your full delivery address for order ' + o.id + ' in ONE message: house / flat number, building, street, area and landmark.');
  return { handled: true, action: 'address_change_requested' };
}

// ------------------------------------------------------------- typed replies

const ADDRESS_WORD = /\b(flat|house|h\.?\s?no|door|plot|floor|apartments?|apt|building|bldg|block|tower|society|complex|residency|villa|street|road|rd|lane|nagar|colony|layout|sector|phase|cross|main|near|opp|opposite|behind|beside|village|post|dist|district|taluk|mandal|ward|extn|gali|marg|chowk|bazaar|market)\b/i;

/**
 * Typed reply → address fields. City, state and PIN stay as the checkout gave them
 * (they decided the courier and the COD fee); a DIFFERENT postcode means a different
 * place and goes to the owner. Returns { address } or { error }.
 */
export function addressFromReply(text, cur = {}, name = '') {
  const raw = String(text || '').trim();
  if (raw.length < 10 || !(/\d/.test(raw) || ADDRESS_WORD.test(raw))) return { error: 'does not look like an address' };
  const other = (raw.match(COD.POSTCODE) || []).find((p) => p !== String(cur.pin || ''));
  if (other) return { error: 'different postcode ' + other };
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const known = new Set([norm(name), norm(cur.city), norm(cur.state), 'india'].filter(Boolean));
  const parts = raw.split(/\r?\n|,(?=\s*[A-Za-z])/).map((p) => p.replace(COD.POSTCODE, '').replace(/^[\s,.-]+|[\s,.-]+$/g, '').replace(/\s+/g, ' '))
    .filter((p) => p && !known.has(norm(p)));
  if (!parts.length) return { error: 'nothing beyond city, state and postcode' };
  const line1 = (parts.length > 1 ? parts.slice(0, -1).join(', ') : parts[0]).slice(0, 200);
  const line2 = parts.length > 1 ? parts[parts.length - 1].slice(0, 200) : '';
  return { address: { ...cur, line1, line2 } };
}

/** Free text from a customer. Returns what it did; anything not handled → owner. */
export async function handleText(env, db, shop, { from, text, name }, now = Date.now()) {
  const sender = national(from, env);
  if (/^\s*(stop|unsubscribe|stop offers)\s*$/i.test(text || '')) {
    await setOptin(db, sender, 'out', now);
    await sendText(env, sender, 'Done - no more offers from ' + shop.name + '. Order updates will still reach you.');
    return { action: 'opted_out' };
  }
  // Waiting order of this number that asked for a new address in the last 48 h.
  const { results } = await db.prepare(`SELECT o.id FROM orders o WHERE o.status = 'pending' AND COALESCE(o.awb, '') = ''
      AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'address_change_requested' AND e.created_at >= ?)
      ORDER BY o.created_at DESC LIMIT 5`).bind(ago(now, COD.ADDRESS_REPLY_WINDOW_H * H)).all();
  for (const r of results || []) {
    const o = await loadOrder(db, r.id);
    if (!o || national(o.phone, env) !== sender) continue;
    const req = await lastEvent(db, o.id, ['address_change_requested']);
    const saved = await lastEvent(db, o.id, ['address_saved']);
    if (saved && saved.created_at >= req.created_at) continue;          // one save per request
    const p = addressFromReply(text, o.address, o.name);
    if (p.error || shop.addressWeak({ ...o, address: p.address })) {
      await logEvent(db, o.id, 'address_reply_unparsed', 0, p.error || 'still weak', now);
      break;   // falls through to the owner below
    }
    await db.prepare('UPDATE orders SET address = ?, updated_at = ? WHERE id = ? AND status = ?').bind(JSON.stringify(p.address), iso(now), o.id, 'pending').run();
    await logEvent(db, o.id, 'address_saved', 1, 'WAS: ' + addrLine(o.address) + '\nNOW: ' + addrLine(p.address), now);
    await sendText(env, o.phone, 'Thank you! Delivery address for order ' + o.id + ' is now:\n' + addrLine(p.address) + '\n\nIf anything is still wrong, just write here.');
    await releaseHeld(env, db, shop, { ...o, address: p.address }, now);
    return { action: 'address_saved', orderId: o.id };
  }
  const short = String(text || '').slice(0, 80);
  await shop.alertOwner(env, 'WhatsApp from ' + (name || 'customer …' + sender.slice(-4)), short + (String(text || '').length > 80 ? '…' : ''));
  return { action: 'owner' };
}

/** Location pin shared: store it, release a held COD question. */
export async function handleLocation(env, db, shop, { from, latitude, longitude }, now = Date.now()) {
  const sender = national(from, env);
  const r = await db.prepare(`SELECT id FROM orders WHERE status = 'pending' AND payment_method = 'cod' ORDER BY created_at DESC LIMIT 20`).all();
  for (const row of r.results || []) {
    const o = await loadOrder(db, row.id);
    if (!o || national(o.phone, env) !== sender) continue;
    await logEvent(db, o.id, 'location_received', 1, latitude + ',' + longitude, now);
    if (await hasEvent(db, o.id, ['cod_confirmed'])) {
      await shop.alertOwner(env, 'Location received - ' + o.id, 'Customer confirmed COD and sent the location pin. Book the courier.');
    } else await releaseHeld(env, db, shop, o, now);
    return { action: 'location_saved', orderId: o.id };
  }
  return { action: 'no_order' };
}

// ------------------------------------------------------------ delivery receipts

/** statuses[] from the webhook: keep wa_messages current; act on an undeliverable COD question. */
export async function handleStatuses(env, db, shop, statuses = [], now = Date.now()) {
  const out = [];
  for (const s of statuses) {
    const code = s.errors && s.errors[0] && s.errors[0].code;
    await db.prepare('UPDATE wa_messages SET status = ?, error_code = COALESCE(?, error_code), updated_at = ? WHERE wamid = ?').bind(s.status, code || null, iso(now), s.id).run();
    if (s.status !== 'failed') continue;
    const msg = await db.prepare('SELECT order_id, kind, phone FROM wa_messages WHERE wamid = ?').bind(s.id).first();
    if (msg && msg.phone && code === ERR.USER_STOPPED_MARKETING) await setOptin(db, msg.phone, 'out', now);
    if (!msg || !msg.order_id || !['cod_question', 'address_question'].includes(msg.kind)) continue;
    if (await hasEvent(db, msg.order_id, ['cod_undeliverable'])) continue;
    await logEvent(db, msg.order_id, 'cod_undeliverable', 1, 'WhatsApp error ' + code, now);
    // Waiting 6 h for a reminder that fails the same way wastes a day: tell the owner now.
    const o = await loadOrder(db, msg.order_id);
    await shop.alertOwner(env, 'WhatsApp cannot reach this customer - ' + msg.order_id,
      (o && o.name ? o.name : 'Customer') + (code === ERR.UNDELIVERABLE ? ' is not on WhatsApp (or blocked us).' : ' could not get the message (error ' + code + ').') + ' Call them to confirm the COD order.');
    out.push(msg.order_id);
  }
  return out;
}

// ------------------------------------------------------------------- the sweep

/** Cron, every 30 min: one reminder after 6 h of silence, owner alert after 24 h. */
export async function sweepCod(env, db, shop, now = Date.now()) {
  const { results } = await db.prepare(`SELECT o.id FROM orders o WHERE o.status = 'pending' AND o.payment_method = 'cod' AND COALESCE(o.awb, '') = ''
      AND o.created_at >= ? ORDER BY o.created_at LIMIT 200`).bind(ago(now, 7 * 24 * H)).all();
  const done = [];
  for (const r of results || []) {
    const ev = await db.prepare(`SELECT kind, ok, created_at FROM order_events WHERE order_id = ? ORDER BY id`).bind(r.id).all();
    const has = (k) => (ev.results || []).find((e) => e.kind === k && e.ok);
    if (has('cod_confirmed') || has('cod_declined') || has('cod_undeliverable')) continue;
    const asked = has('cod_question_sent') || has('address_question_sent');
    if (!asked) continue;
    const hours = (now - Date.parse(asked.created_at.replace(' ', 'T') + 'Z')) / H;
    if (hours >= COD.REMIND_AFTER_H && !has('cod_reminder_sent') && has('cod_question_sent')) {
      const o = await loadOrder(db, r.id);
      const s = await sendCodQuestion(env, db, shop, o, 'reminder', now);
      done.push({ id: r.id, reminder: s.sent });
    }
    if (hours >= COD.OWNER_ALERT_AFTER_H && !has('cod_noreply_alert')) {
      const o = await loadOrder(db, r.id);
      await logEvent(db, r.id, 'cod_noreply_alert', 1, 'no WhatsApp answer in ' + COD.OWNER_ALERT_AFTER_H + ' h', now);
      await shop.alertOwner(env, 'No COD answer in ' + COD.OWNER_ALERT_AFTER_H + ' h - ' + r.id, (o.name || 'Customer') + ' has not confirmed or cancelled. Call them, then confirm or cancel in the admin.');
      done.push({ id: r.id, ownerAlert: true });
    }
    if (COD.AUTO_CANCEL_AFTER_H && hours >= COD.AUTO_CANCEL_AFTER_H) {
      const o = await loadOrder(db, r.id);
      if (await setStatus(db, r.id, 'pending', 'cancelled', now)) {
        await logEvent(db, r.id, 'cancelled', 1, 'auto: no answer in ' + COD.AUTO_CANCEL_AFTER_H + ' h', now);
        await shop.cancel(env, db, { ...o, status: 'cancelled' }, 'no COD answer').catch(() => null);
        done.push({ id: r.id, autoCancelled: true });
      }
    }
  }
  return done;
}
