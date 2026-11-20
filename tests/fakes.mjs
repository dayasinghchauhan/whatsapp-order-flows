// Minimal stand-ins for D1, R2 and KV, so the templates run under `node --test`.
import { DatabaseSync } from 'node:sqlite';

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const self = { down: false };
  const guard = () => { if (self.down) throw new Error('D1_ERROR: database unavailable'); };
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async (col) => { guard(); const r = db.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    all: async () => { guard(); return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }; },
    run: async () => { guard(); const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  self.prepare = (sql) => stmt(sql);
  self.exec = (sql) => db.exec(sql);
  return self;
}

export function fakeR2() {
  const objects = new Map();
  const self = { down: false, puts: 0, objects };
  const guard = () => { if (self.down) throw new Error('R2 error 10043: service unavailable'); };
  self.list = async ({ prefix = '', limit = 1000 } = {}) => {
    guard();
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
    return { objects: keys.map((k) => ({ key: k, uploaded: objects.get(k).uploaded })), truncated: false };
  };
  self.get = async (k) => { guard(); const o = objects.get(k); return o ? { text: async () => o.body } : null; };
  self.put = async (k, body, _opts, uploaded = new Date()) => { guard(); self.puts++; objects.set(k, { body: String(body), uploaded }); };
  return self;
}

export function fakeKV() {
  const m = new Map();
  return { puts: 0, get: async (k) => (m.has(k) ? m.get(k) : null), async put(k, v) { this.puts++; m.set(k, v); } };
}

/** Records alerts instead of sending them. */
export function recorder() {
  const calls = [];
  const send = async (_env, title, text) => { calls.push({ title, text }); return { discord: true }; };
  return { calls, send };
}
