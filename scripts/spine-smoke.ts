// scripts/spine-smoke.ts — end-to-end proof of the spine against a live McSecretary.
// Usage: MCSECRETARY_URL=https://... AGENT_KEY=... npx tsx scripts/spine-smoke.ts
//
// Files a run record, an event, and one noop proposal, then drains the event.
// The proposal targets a path that does not exist on content-engine, so approving
// it on the phone proves the whole chain (claim → trust → hand call with bearer →
// result recorded → reply) with a harmless, recorded 404. Nothing real is changed.
const base = process.env.MCSECRETARY_URL;
const key = process.env.AGENT_KEY;
if (!base || !key) {
  console.error('Set MCSECRETARY_URL and AGENT_KEY');
  process.exit(2);
}
const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
const now = new Date();
const expires = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
let failures = 0;

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<void> {
  const r = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const ok = r.status === 200;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
}

await call('POST', '/spine/runs', {
  run_id: `smoke-${now.getTime()}`, brand_id: 'dearborn-denim', skill_commit: 'smoke', model: 'none',
  started_at: now.toISOString(), finished_at: now.toISOString(), outcome: 'ok', notes: 'spine smoke',
});
await call('POST', '/spine/events', {
  source_hand: 'smoke', brand_id: 'dearborn-denim', event_type: 'smoke_ping', payload: { at: now.toISOString() }, urgent: false,
});
await call('POST', '/spine/proposals', {
  brand_id: 'dearborn-denim', action_type: 'noop',
  action_payload: { hand: 'content-engine', method: 'POST', path: `/spine-smoke/${now.getTime()}`, body: { smoke: true } },
  reason: 'Spine smoke test. Approve to prove execution (expect a recorded 404), reject to prove the ledger, edit to try key=value.',
  evidence: { smoke: true, at: now.toISOString() }, cost_usd: 0, reversible: true, level_required: 1, expires_at: expires,
});
await call('GET', '/spine/events/drain?types=smoke_ping');
await call('GET', '/spine/trust');
await call('GET', '/spine/brands/dearborn-denim');

console.log(failures === 0 ? '\nAll calls returned 200. Check the phone for the card.' : `\n${failures} call(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
