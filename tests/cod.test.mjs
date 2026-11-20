import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeD1 } from './fakes.mjs';
import { startCod, handleButton, handleText, handleStatuses, sweepCod, addressFromReply } from '../templates/lib/cod.js';
import { sweepRebook } from '../templates/lib/rebook.js';
import { sweepAbandoned, recordAttempt } from '../templates/lib/abandon.js';
import { iso, H, MIN, DAY } from '../templates/lib/store.js';
import { hmacHex } from '../templates/lib/wa.js';
import { onRequestPost, onRequestGet } from '../templates/functions/api/webhooks/whatsapp.js';
import { shop as baseShop } from '../templates/config.js';

const SCHEMA = readFileSync(new URL('../templates/schema.sql', import.meta.url), 'utf8');
const T0 = Date.parse('2026-03-02T06:00:00Z');
const GOOD = { line1: 'Flat 12, Green Towers', line2: 'MG Road', city: 'Pune', state: 'Maharashtra', pin: '411001' };
const WEAK = { line1: 'Street', line2: '', city: 'Pune', state: 'Maharashtra', pin: '411001' };

let sent, alerts, booked, cancelled, refuse;
const env = { WA_PHONE_ID: '1', WA_TOKEN: 't', WA_APP_SECRET: 'secret', WA_VERIFY_TOKEN: 'vt' };
function mkShop() {
  return { ...baseShop, ownPhones: ['9999999999'],
    book: async (_e, _d, o) => { booked.push(o.id); return { ok: true, awb: 'AWB1' }; },
    cancel: async (_e, _d, o) => { cancelled.push(o.id); return { ok: true }; },
    alertOwner: async (_e, title, body) => { alerts.push({ title, body }); } };
}
let db, shop;
beforeEach(() => {
  sent = []; alerts = []; booked = []; cancelled = []; refuse = {};
  db = fakeD1(); db.exec(SCHEMA); shop = mkShop();
  globalThis.fetch = async (url, o) => {
    const p = JSON.parse(o.body);
    const name = p.template && p.template.name;
    sent.push(p);
    if (name && refuse[name]) return Response.json({ error: { code: refuse[name], message: 'refused ' + refuse[name] } }, { status: 400 });
    return Response.json({ messages: [{ id: 'wamid.' + sent.length }] });
  };
});
const tpl = () => sent.filter((p) => p.type === 'template').map((p) => p.template.name);
const texts = () => sent.filter((p) => p.type === 'text').map((p) => p.text.body);
async function order(id, { phone = '9876543210', address = GOOD, status = 'pending', pm = 'cod', at = T0, items = [{ sku: 'A1', name: 'Blue Mug', qty: 1, price: 49900 }] } = {}) {
  await db.prepare('INSERT INTO orders (id, name, phone, items, total, address, payment_method, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, 'Asha Rao', phone, JSON.stringify(items), 49900, JSON.stringify(address), pm, status, iso(at), iso(at)).run();
}
const status = async (id) => (await db.prepare('SELECT status FROM orders WHERE id = ?').bind(id).first()).status;
const events = async (id) => (await db.prepare('SELECT kind FROM order_events WHERE order_id = ? ORDER BY id').bind(id).all()).results.map((r) => r.kind);

// ------------------------------------------------------------------ COD

test('good address → COD question with photo header + CODY/CODN payloads', async () => {
  await order('ORD-1');
  await startCod(env, db, shop, 'ORD-1', T0);
  assert.deepEqual(tpl(), ['cod_order_confirm']);
  const comps = sent[0].template.components;
  assert.equal(comps[0].type, 'header');
  assert.deepEqual(comps.filter((c) => c.sub_type === 'quick_reply').map((c) => c.parameters[0].payload), ['CODY|ORD-1', 'CODN|ORD-1']);
  assert.equal(sent[0].to, '919876543210');
  await startCod(env, db, shop, 'ORD-1', T0 + MIN);
  assert.equal(tpl().length, 1, 'never asked twice');
});

test('weak address → address question first; "Address is correct" releases the COD question', async () => {
  await order('ORD-2', { address: WEAK });
  await startCod(env, db, shop, 'ORD-2', T0);
  assert.deepEqual(tpl(), ['address_confirm']);
  assert.ok((await events('ORD-2')).includes('cod_held'));
  await handleButton(env, db, shop, { from: '919876543210', payload: 'ADRY|ORD-2' }, T0 + MIN);
  assert.deepEqual(tpl(), ['address_confirm', 'cod_order_confirm']);
});

test('Yes → confirmed + booked once; duplicate and wrong-phone taps ignored', async () => {
  await order('ORD-3'); await startCod(env, db, shop, 'ORD-3', T0);
  const wrong = await handleButton(env, db, shop, { from: '911111111111', payload: 'CODY|ORD-3' }, T0 + MIN);
  assert.equal(wrong.ignored, 'wrong phone');
  const r = await handleButton(env, db, shop, { from: '919876543210', payload: 'CODY|ORD-3' }, T0 + MIN);
  assert.equal(r.action, 'confirmed');
  assert.equal(await status('ORD-3'), 'confirmed');
  await handleButton(env, db, shop, { from: '919876543210', payload: 'CODY|ORD-3' }, T0 + 2 * MIN);
  assert.deepEqual(booked, ['ORD-3']);
  assert.match(texts()[0], /confirmed/);
});

test('No → cancelled, cancel hook (restock) called, one reply; late taps answered once', async () => {
  await order('ORD-4'); await startCod(env, db, shop, 'ORD-4', T0);
  await handleButton(env, db, shop, { from: '9876543210', payload: 'CODN|ORD-4' }, T0 + MIN);
  assert.equal(await status('ORD-4'), 'cancelled');
  assert.deepEqual(cancelled, ['ORD-4']);
  await handleButton(env, db, shop, { from: '9876543210', payload: 'CODY|ORD-4' }, T0 + 2 * MIN);
  await handleButton(env, db, shop, { from: '9876543210', payload: 'CODY|ORD-4' }, T0 + 3 * MIN);
  assert.equal(texts().filter((t) => /already cancelled/.test(t)).length, 1);
  assert.deepEqual(booked, []);
});

test('silence: one reminder at 6 h, one owner alert at 24 h, nothing more', async () => {
  await order('ORD-5'); await startCod(env, db, shop, 'ORD-5', T0);
  await sweepCod(env, db, shop, T0 + 5 * H);
  assert.equal(tpl().length, 1);
  await sweepCod(env, db, shop, T0 + 6 * H);
  await sweepCod(env, db, shop, T0 + 7 * H);
  assert.equal(tpl().length, 2);
  await sweepCod(env, db, shop, T0 + 24 * H);
  await sweepCod(env, db, shop, T0 + 30 * H);
  assert.equal(alerts.filter((a) => /No COD answer/.test(a.title)).length, 1);
  assert.ok(!alerts[0].body.includes('9876543210'), 'no phone number in owner alerts');
  assert.equal(await status('ORD-5'), 'pending', 'never auto-cancelled by default');
});

test('undeliverable (131026) → owner told at once, no 6 h reminder', async () => {
  await order('ORD-6'); await startCod(env, db, shop, 'ORD-6', T0);
  const wamid = (await db.prepare("SELECT wamid FROM wa_messages WHERE order_id = 'ORD-6'").first()).wamid;
  await handleStatuses(env, db, shop, [{ id: wamid, status: 'failed', errors: [{ code: 131026 }] }], T0 + MIN);
  assert.match(alerts[0].title, /cannot reach/);
  await sweepCod(env, db, shop, T0 + 7 * H);
  assert.equal(tpl().length, 1);
});

test('"Change address" → typed reply saved, held COD question released', async () => {
  await order('ORD-7', { address: WEAK }); await startCod(env, db, shop, 'ORD-7', T0);
  await handleButton(env, db, shop, { from: '9876543210', payload: 'ADRN|ORD-7' }, T0 + MIN);
  const r = await handleText(env, db, shop, { from: '919876543210', text: 'House 21, Lake View Society\nNear City Mall, Pune 411001' }, T0 + 2 * MIN);
  assert.equal(r.action, 'address_saved');
  const a = JSON.parse((await db.prepare("SELECT address FROM orders WHERE id = 'ORD-7'").first()).address);
  assert.match(a.line1, /House 21/);
  assert.equal(a.pin, '411001');
  assert.deepEqual(tpl(), ['address_confirm', 'cod_order_confirm']);
});

test('address parser: different postcode or chit-chat goes to the owner', () => {
  assert.match(addressFromReply('Flat 3, Sun Apts, Pune 411038', GOOD).error, /different postcode/);
  assert.match(addressFromReply('ok thank you', GOOD).error, /does not look/);
  const a = addressFromReply('Plot 7, Shanti Nagar, Pune', GOOD).address;
  assert.equal(a.line1, 'Plot 7');            // city (Pune) dropped: it stays as the checkout gave it
  assert.equal(a.line2, 'Shanti Nagar');
  assert.equal(a.pin, '411001');
});

test('STOP → opted out', async () => {
  const r = await handleText(env, db, shop, { from: '919876543210', text: 'STOP' }, T0);
  assert.equal(r.action, 'opted_out');
  assert.equal((await db.prepare("SELECT status FROM wa_optin WHERE phone = '9876543210'").first()).status, 'out');
});

// --------------------------------------------------------------- rebook

async function silentCancelled(id, phone = '9876543210', at = T0) {
  await order(id, { phone, at }); await startCod(env, db, shop, id, at);
  await sweepCod(env, db, shop, at + 24 * H);   // reminder + owner alert
  await db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").bind(id).run();
  await db.prepare("INSERT INTO order_events (order_id, kind, ok, detail, created_at) VALUES (?, 'cancelled', 1, 'owner', ?)").bind(id, iso(at + 25 * H)).run();
}

test('rebook: only after 24 h, once per number ever', async () => {
  await silentCancelled('ORD-8');
  sent = [];
  await sweepRebook(env, db, shop, T0 + 30 * H);
  assert.deepEqual(tpl(), [], 'not before 24 h after cancel');
  await sweepRebook(env, db, shop, T0 + 50 * H);
  assert.deepEqual(tpl(), ['order_rebook']);
  const btn = sent[0].template.components.find((c) => c.sub_type === 'url');
  assert.equal(btn.parameters[0].text, 'A1-1');
  await silentCancelled('ORD-9', '9876543210', T0 + 2 * H);
  await sweepRebook(env, db, shop, T0 + 60 * H);
  assert.equal(tpl().filter((t) => t === 'order_rebook').length, 1, 'once per number');
});

test('rebook: skipped when the number ordered again; waits while template is in review', async () => {
  await silentCancelled('ORD-10', '9000000010');
  await order('ORD-11', { phone: '9000000010', at: T0 + 26 * H, status: 'confirmed' });
  await silentCancelled('ORD-12', '9000000012');
  refuse.order_rebook = 132001;
  sent = [];
  await sweepRebook(env, db, shop, T0 + 50 * H);
  assert.ok((await events('ORD-10')).includes('rebook_skipped'));
  assert.ok(!(await events('ORD-12')).some((k) => k.startsWith('rebook')), 'template not ready: nothing marked');
  delete refuse.order_rebook;
  await sweepRebook(env, db, shop, T0 + 51 * H);
  assert.ok((await events('ORD-12')).includes('rebook_sent'));
});

// -------------------------------------------------------------- abandoned

test('abandoned: waits by signal, newest try only, own number never', async () => {
  await recordAttempt(db, { id: 'pay_1', phone: '+91 98765 43210', name: 'Asha', items: [{ sku: 'A1', name: 'Blue Mug' }], status: 'failed' }, env, T0);
  await recordAttempt(db, { id: 'pay_2', phone: '9876543210', name: 'Asha', items: [{ sku: 'A1', name: 'Blue Mug' }], status: 'dismissed' }, env, T0 + MIN);
  await recordAttempt(db, { id: 'pay_3', phone: '9999999999', name: 'Owner', items: [], status: 'failed' }, env, T0);
  await sweepAbandoned(env, db, shop, T0 + 20 * MIN);
  assert.deepEqual(tpl(), [], 'dismissed waits 30 min');
  await sweepAbandoned(env, db, shop, T0 + 35 * MIN);
  assert.deepEqual(tpl(), ['bag_reminder_v2']);
  assert.equal((await db.prepare("SELECT attempt_id FROM wa_messages WHERE kind = 'bag_reminder'").first()).attempt_id, 'pay_2');
});

test('abandoned: ordered since blocks, but a CANCELLED order does not', async () => {
  await recordAttempt(db, { id: 'pay_4', phone: '9000000004', name: 'Ravi', items: [], status: 'failed' }, env, T0);
  await order('ORD-13', { phone: '9000000004', at: T0 + 5 * MIN, status: 'cancelled' });
  await sweepAbandoned(env, db, shop, T0 + 20 * MIN);
  assert.equal(tpl().length, 1);
  await recordAttempt(db, { id: 'pay_5', phone: '9000000005', name: 'Mina', items: [], status: 'failed' }, env, T0);
  await order('ORD-14', { phone: '9000000005', at: T0 + 5 * MIN, status: 'confirmed', pm: 'prepaid' });
  await sweepAbandoned(env, db, shop, T0 + 20 * MIN);
  assert.equal(tpl().length, 1);
});

test('abandoned: 2 per 7 days, 24 h apart; a Meta-refused (131049) send counts for the gap, not the cap', async () => {
  const p = '9000000006';
  refuse.bag_reminder_v2 = 131049;
  await recordAttempt(db, { id: 'a1', phone: p, name: 'Kiran', items: [], status: 'failed' }, env, T0);
  await sweepAbandoned(env, db, shop, T0 + 20 * MIN);                       // refused
  delete refuse.bag_reminder_v2;
  await recordAttempt(db, { id: 'a2', phone: p, name: 'Kiran', items: [], status: 'failed' }, env, T0 + 2 * H);
  await sweepAbandoned(env, db, shop, T0 + 3 * H);
  assert.equal(tpl().length, 1, '24 h gap holds even after a refused send');
  await recordAttempt(db, { id: 'a3', phone: p, name: 'Kiran', items: [], status: 'failed' }, env, T0 + 25 * H);
  await sweepAbandoned(env, db, shop, T0 + 26 * H);
  await recordAttempt(db, { id: 'a4', phone: p, name: 'Kiran', items: [], status: 'failed' }, env, T0 + 50 * H);
  await sweepAbandoned(env, db, shop, T0 + 51 * H);
  await recordAttempt(db, { id: 'a5', phone: p, name: 'Kiran', items: [], status: 'failed' }, env, T0 + 76 * H);
  await sweepAbandoned(env, db, shop, T0 + 77 * H);
  const ok = (await db.prepare("SELECT COUNT(*) n FROM wa_messages WHERE phone = ? AND kind = 'bag_reminder' AND status != 'failed'").bind(p).first('n'));
  assert.equal(ok, 2, 'cap = 2 delivered-or-pending in 7 days');
  assert.ok(alerts.some((a) => /Warm buyer/.test(a.title)), '3rd try → owner alert');
  assert.ok(alerts.every((a) => !a.body.includes(p)));
});

test('abandoned: falls back to the older template while the newest is in review', async () => {
  refuse.bag_reminder_v2 = 132015;
  await recordAttempt(db, { id: 'b1', phone: '9000000007', name: 'Dev', items: [], status: 'failed' }, env, T0);
  await sweepAbandoned(env, db, shop, T0 + 20 * MIN);
  assert.deepEqual(tpl(), ['bag_reminder_v2', 'bag_reminder']);
});

// ---------------------------------------------------------------- webhook

test('webhook: Meta verify, bad signature ignored, signed tap handled', async () => {
  const get = await onRequestGet({ request: new Request('https://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42'), env });
  assert.equal(await get.text(), '42');
  await order('ORD-15'); await startCod(env, db, shop, 'ORD-15', Date.now());
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '919876543210', type: 'button', button: { payload: 'CODY|ORD-15' } }] } }] }] });
  const e = { ...env, DB: db };
  await onRequestPost({ request: new Request('https://x', { method: 'POST', body, headers: { 'X-Hub-Signature-256': 'sha256=bad' } }), env: e });
  assert.equal(await status('ORD-15'), 'pending');
  const sig = 'sha256=' + await hmacHex('secret', body);
  await onRequestPost({ request: new Request('https://x', { method: 'POST', body, headers: { 'X-Hub-Signature-256': sig } }), env: e });
  assert.equal(await status('ORD-15'), 'confirmed');
});
