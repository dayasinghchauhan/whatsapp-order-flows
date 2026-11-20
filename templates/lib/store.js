/**
 * Small D1 helpers shared by cod.js, rebook.js and abandon.js.
 * Times are written by the code ('YYYY-MM-DD HH:MM:SS' UTC, SQLite's own format),
 * so every rule can be tested with an injected clock.
 */
export const iso = (t = Date.now()) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
export const ago = (now, ms) => iso(now - ms);
export const H = 3_600_000, MIN = 60_000, DAY = 86_400_000;
export const parseJson = (s, d) => { try { return typeof s === 'string' ? JSON.parse(s) : (s ?? d); } catch { return d; } };

export async function logEvent(db, orderId, kind, ok, detail, now = Date.now()) {
  await db.prepare('INSERT INTO order_events (order_id, kind, ok, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(String(orderId), kind, ok ? 1 : 0, String(detail || '').slice(0, 1000), iso(now)).run();
}

/** Latest event of any of `kinds` (or null). */
export async function lastEvent(db, orderId, kinds) {
  return db.prepare(`SELECT kind, ok, detail, created_at FROM order_events WHERE order_id = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`)
    .bind(String(orderId), ...kinds).first();
}
export const hasEvent = async (db, orderId, kinds) => !!(await lastEvent(db, orderId, kinds));

export async function saveMessage(db, { wamid, phone, orderId = null, attemptId = null, kind, template = null, status = 'sent', errorCode = null }, now = Date.now()) {
  if (!wamid) return;
  await db.prepare(`INSERT OR REPLACE INTO wa_messages (wamid, phone, order_id, attempt_id, kind, template, status, error_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(wamid, phone, orderId, attemptId, kind, template, status, errorCode, iso(now), iso(now)).run();
}

export async function optedOut(db, phone) {
  const r = await db.prepare("SELECT status FROM wa_optin WHERE phone = ?").bind(phone).first();
  return !!(r && r.status === 'out');
}
export async function setOptin(db, phone, status, now = Date.now()) {
  await db.prepare(`INSERT INTO wa_optin (phone, status, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`).bind(phone, status, iso(now)).run();
}
