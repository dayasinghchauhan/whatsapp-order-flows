/**
 * WhatsApp Cloud API webhook (Pages Function: /api/webhooks/whatsapp).
 *
 * GET  = Meta's one-time verification (hub.verify_token must equal WA_VERIFY_TOKEN).
 * POST = messages + delivery receipts. Signed with X-Hub-Signature-256 (app secret).
 *        An unsigned or badly signed body is IGNORED but still answered 200, so
 *        Meta does not retry it for days.
 *
 * Always answer 200 quickly: Meta retries on errors and on slow (>~10 s) answers,
 * which would replay a button tap. The handlers are idempotent anyway.
 */
import { verifySignature } from '../../../lib/wa.js';
import { handleButton, handleText, handleLocation, handleStatuses } from '../../../lib/cod.js';
import { shop } from '../../../config.js';

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  if (u.searchParams.get('hub.mode') === 'subscribe' && env.WA_VERIFY_TOKEN && u.searchParams.get('hub.verify_token') === env.WA_VERIFY_TOKEN) {
    return new Response(u.searchParams.get('hub.challenge') || '', { status: 200 });
  }
  return new Response('forbidden', { status: 403 });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const raw = await request.arrayBuffer();
  if (!(await verifySignature(env.WA_APP_SECRET, raw, request.headers.get('X-Hub-Signature-256')))) {
    return new Response('ignored', { status: 200 });
  }
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return new Response('ok'); }
  const job = dispatch(env, env.DB, body).catch((e) => console.log('wa webhook error', String(e && e.message || e)));
  if (context.waitUntil) context.waitUntil(job); else await job;
  return new Response('ok');
}

export async function dispatch(env, db, body, now = Date.now()) {
  const out = [];
  for (const entry of body.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));
    if (v.statuses) out.push({ statuses: await handleStatuses(env, db, shop, v.statuses, now) });
    for (const m of v.messages || []) {
      const from = m.from;
      if (m.type === 'button') out.push(await handleButton(env, db, shop, { from, payload: m.button && m.button.payload }, now));
      else if (m.type === 'interactive' && m.interactive && m.interactive.button_reply) out.push(await handleButton(env, db, shop, { from, payload: m.interactive.button_reply.id }, now));
      else if (m.type === 'text') out.push(await handleText(env, db, shop, { from, text: m.text && m.text.body, name: names[from] }, now));
      else if (m.type === 'location') out.push(await handleLocation(env, db, shop, { from, latitude: m.location.latitude, longitude: m.location.longitude }, now));
      else out.push(await handleText(env, db, shop, { from, text: '[' + m.type + ']', name: names[from] }, now));
    }
  }
  return out;
}
