/**
 * WhatsApp Cloud API: the few calls the COD lifecycle needs. No SDK.
 *
 * env:
 *   WA_PHONE_ID      phone number ID (WhatsApp Manager → API setup)
 *   WA_TOKEN         system-user permanent token (whatsapp_business_messaging)
 *   WA_APP_SECRET    app secret, for X-Hub-Signature-256 on the webhook
 *   WA_COUNTRY_CODE  default "91"
 *   WA_PHONE_DIGITS  national number length, default 10
 *   WA_MOCK          "true" on staging: nothing is sent, the call is returned as a preview
 *   WA_API_VERSION   default "v22.0"
 */

export const ERR = {
  UNDELIVERABLE: 131026,        // not on WhatsApp / old app / blocked us: call instead
  WINDOW_CLOSED: 131047,        // >24 h since the customer last wrote: only a template may go
  ECOSYSTEM_LIMIT: 131049,      // Meta chose not to deliver (marketing fatigue): do not retry at once
  SPAM_RATE: 131048,            // number flagged for spam: stop the run
  USER_STOPPED_MARKETING: 131050,
  THROUGHPUT: 130429,
  // template not usable yet / any more: keep the job waiting, never mark it done
  TEMPLATE_NOT_READY: new Set([132000, 132001, 132005, 132007, 132015, 132016]),
};
export const STOP_RUN = new Set([ERR.SPAM_RATE, ERR.THROUGHPUT, 80007]);

export function national(phone, env = {}) {
  const n = Number(env.WA_PHONE_DIGITS || 10);
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= n ? d.slice(-n) : '';
}
export const e164 = (phone, env = {}) => { const n = national(phone, env); return n ? String(env.WA_COUNTRY_CODE || '91') + n : ''; };

async function post(env, payload) {
  if (String(env.WA_MOCK) === 'true') return { sent: true, mock: true, msgId: 'mock-' + Math.random().toString(36).slice(2, 10), preview: payload };
  if (!env.WA_PHONE_ID || !env.WA_TOKEN) return { sent: false, error: 'WA_PHONE_ID / WA_TOKEN not set' };
  try {
    const r = await fetch(`https://graph.facebook.com/${env.WA_API_VERSION || 'v22.0'}/${env.WA_PHONE_ID}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.WA_TOKEN }, body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { sent: true, msgId: j.messages && j.messages[0] && j.messages[0].id };
    return { sent: false, code: j.error && j.error.code, error: (j.error && (j.error.error_data && j.error.error_data.details || j.error.message)) || 'HTTP ' + r.status };
  } catch (e) { return { sent: false, error: String((e && e.message) || e) }; }
}

/**
 * Approved template. `payloads` = one string per QUICK_REPLY button, in order:
 * the webhook gets it back on a tap, so put the action + order id in it ("CODY|ORD-123").
 * `headerImage` = https URL of a JPG/PNG (WebP is refused), or omit for no header.
 * `urlButton` = { index, suffix } for a dynamic URL button.
 */
export async function sendTemplate(env, { to, name, lang = 'en', params = [], headerImage, payloads = [], urlButton }) {
  const num = e164(to, env);
  if (!num) return { sent: false, error: 'invalid phone' };
  const components = [];
  if (headerImage) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImage } }] });
  if (params.length) components.push({ type: 'body', parameters: params.map((v) => ({ type: 'text', text: String(v == null ? '' : v).replace(/[\n\t]+/g, ' ').replace(/ {5,}/g, '    ').slice(0, 1000) || '-' })) });
  payloads.forEach((p, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: p }] }));
  if (urlButton) components.push({ type: 'button', sub_type: 'url', index: String(urlButton.index || 0), parameters: [{ type: 'text', text: urlButton.suffix }] });
  return post(env, { messaging_product: 'whatsapp', to: num, type: 'template', template: { name, language: { code: lang }, components } });
}

/** Free text: only inside the 24 h after the customer last wrote or tapped. */
export async function sendText(env, to, text) {
  const num = e164(to, env);
  if (!num) return { sent: false, error: 'invalid phone' };
  return post(env, { messaging_product: 'whatsapp', to: num, type: 'text', text: { body: String(text).slice(0, 4096), preview_url: true } });
}

/** "Send location" button (free-form, so 24 h window only). */
export async function sendLocationRequest(env, to, text) {
  const num = e164(to, env);
  if (!num) return { sent: false, error: 'invalid phone' };
  return post(env, { messaging_product: 'whatsapp', to: num, type: 'interactive', recipient_type: 'individual',
    interactive: { type: 'location_request_message', body: { text: String(text).slice(0, 1024) }, action: { name: 'send_location' } } });
}

// ---------------------------------------------------------------- webhook auth

const enc = new TextEncoder();
export async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, typeof body === 'string' ? enc.encode(body) : body);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function constantTimeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = !a || !b ? 1 : a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
/** X-Hub-Signature-256 over the RAW body bytes. Never act on an unsigned webhook. */
export async function verifySignature(secret, rawBody, header) {
  if (!secret) return false;
  return constantTimeEqual(header || '', 'sha256=' + (await hmacHex(secret, rawBody)));
}
