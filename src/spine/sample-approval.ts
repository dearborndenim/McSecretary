/**
 * The sample gate (agentic design workflow spec 2026-10-15 §3.6, §4.7; build C5).
 *
 * `sample_approval` is a pinned action type (`gates.ts`): the Pattern Maker files
 * one after a `pattern_draft` executes, so the card IS the sample request, and
 * Robert's decision on it is the sewn sample's verdict:
 *
 *   Approve → `POST design-module /api/techpacks/<tid>/proven {verdict: "approved", notes, ...}`;
 *             every callout the pack drafted becomes `proven` for the pack's brand on its
 *             archetype (design-module's brand maturity overlay).
 *   Reject  → the same call with `verdict: "rejected"`: recorded on the pack, nothing flips.
 *   Edit    → `notes=<text>` passes it with notes; `fail_notes=<text>` fails it with notes
 *             (an edit reply executes at once, and a multi-word value must be the
 *             only key, so failing-with-notes needs its own key). The executor
 *             folds `fail_notes` into `{verdict: "rejected", notes}` before sending.
 *
 * Both verdicts execute and emit `sample_approval_executed` with `techpack_id`,
 * `verdict` and `brand` flattened onto the event. The payload is re-validated at
 * execution so neither an agent nor an edit can point a sample card anywhere but
 * the pack's own `/proven` route.
 */

import { isPlainObject } from './json-object.js';
import type { ActionPayload } from './types.js';

export const SAMPLE_ACTION_TYPE = 'sample_approval';
export const SAMPLE_HAND = 'design-module';
export const SAMPLE_VERDICTS: ReadonlyArray<string> = Object.freeze(['approved', 'rejected']);
/** Keys `emitExecutedEvent` writes from the sample body/response, authoritative over flattening. */
export const SAMPLE_EVENT_KEYS = ['techpack_id', 'verdict', 'brand'] as const;

/** design-module's techpack slugs (`slugify_techpack`): lowercase, digits, hyphens. */
const TECHPACK_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const PROVEN_PATH_RE = /^\/api\/techpacks\/([a-z0-9][a-z0-9-]{0,127})\/proven$/;
const NOTES_MAX = 2000;

export type SampleValidation =
  | { ok: true; techpackId: string; verdict: string; body: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * A `sample_approval` payload the executor may send, and the body it sends:
 * a non-empty `fail_notes` becomes `verdict: "rejected"` with those notes, and
 * `fail_notes` itself never reaches design-module.
 */
export function validateSamplePayload(payload: ActionPayload): SampleValidation {
  if (payload.hand !== SAMPLE_HAND) return { ok: false, error: `sample_approval must target hand '${SAMPLE_HAND}', not '${payload.hand}'` };
  if (payload.method !== 'POST') return { ok: false, error: 'sample_approval must POST' };
  const m = PROVEN_PATH_RE.exec(payload.path);
  if (!m) return { ok: false, error: `sample_approval path must be /api/techpacks/<id>/proven, not '${payload.path}'` };
  const body = payload.body;
  if (!isPlainObject(body)) return { ok: false, error: 'sample_approval body must be an object' };
  const tid = body.techpack_id;
  if (typeof tid !== 'string' || !TECHPACK_RE.test(tid) || tid !== m[1]) {
    return { ok: false, error: 'sample_approval body.techpack_id must name the pack in the path' };
  }
  if (body.fail_notes !== undefined && (typeof body.fail_notes !== 'string' || body.fail_notes.length > NOTES_MAX)) {
    return { ok: false, error: `sample_approval fail_notes must be a string of at most ${NOTES_MAX} characters` };
  }
  const { fail_notes: failNotes, ...rest } = body;
  const failed = typeof failNotes === 'string' && failNotes.trim().length > 0;
  const sendBody: Record<string, unknown> = failed ? { ...rest, verdict: 'rejected', notes: failNotes.trim() } : rest;
  const verdict = sendBody.verdict;
  if (typeof verdict !== 'string' || !SAMPLE_VERDICTS.includes(verdict)) {
    return { ok: false, error: `sample_approval verdict must be one of ${SAMPLE_VERDICTS.join('|')}` };
  }
  if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > NOTES_MAX)) {
    return { ok: false, error: `sample_approval notes must be a string of at most ${NOTES_MAX} characters` };
  }
  if (body.sample_ref !== undefined && body.sample_ref !== null && typeof body.sample_ref !== 'string') {
    return { ok: false, error: 'sample_approval sample_ref must be a string' };
  }
  if (body.revision !== undefined && !(typeof body.revision === 'number' && Number.isInteger(body.revision))) {
    return { ok: false, error: 'sample_approval revision must be an integer' };
  }
  return { ok: true, techpackId: tid, verdict, body: sendBody };
}

/** `payload` with its body's verdict set to `verdict` (a Reject tap on a sample card). */
export function withVerdict(payload: ActionPayload, verdict: 'approved' | 'rejected'): ActionPayload {
  return { ...payload, body: { ...payload.body, verdict } };
}

/**
 * The three keys the sample's executed event carries flat: the pack id and verdict from
 * the body (what was sent), the brand from design-module's answer (the PACK's brand, which
 * the route resolves from its collection), else the spine brand.
 */
export function sampleEventKeys(body: unknown, response: unknown, brandId: string): Record<string, string> {
  const b = isPlainObject(body) ? body : {};
  const r = isPlainObject(response) ? response : {};
  const out: Record<string, string> = {};
  const tid = typeof r.id === 'string' ? r.id : b.techpack_id;
  if (typeof tid === 'string') out.techpack_id = tid;
  const verdict = typeof r.verdict === 'string' ? r.verdict : b.verdict;
  if (typeof verdict === 'string') out.verdict = verdict;
  out.brand = typeof r.brand === 'string' && r.brand.length > 0 ? r.brand : brandId;
  return out;
}
