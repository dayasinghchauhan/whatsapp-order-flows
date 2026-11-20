/**
 * GET /api/cron/wa-sweep   header x-cron-key: <CRON_KEY>
 * Pages has no cron of its own: call this every 30 min from cron-job.org, a
 * scheduled Worker, or GitHub Actions. (A Worker app can call the three sweeps
 * from its `scheduled` handler instead.)
 */
import { sweepCod } from '../../../lib/cod.js';
import { sweepRebook } from '../../../lib/rebook.js';
import { sweepAbandoned } from '../../../lib/abandon.js';
import { constantTimeEqual } from '../../../lib/wa.js';
import { shop } from '../../../config.js';

export async function onRequest({ request, env }) {
  if (!constantTimeEqual(request.headers.get('x-cron-key'), env.CRON_KEY)) return new Response('Unauthorized', { status: 401 });
  const run = async (name, f) => { try { return await f(); } catch (e) { return { error: name + ': ' + String(e && e.message || e) }; } };
  const result = {
    cod: await run('cod', () => sweepCod(env, env.DB, shop)),
    rebook: await run('rebook', () => sweepRebook(env, env.DB, shop)),
    abandoned: await run('abandoned', () => sweepAbandoned(env, env.DB, shop)),
  };
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
