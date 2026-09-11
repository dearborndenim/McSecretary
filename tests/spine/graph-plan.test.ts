import { describe, it, expect } from 'vitest';
import {
  validateDispatchPlan, defaultSeason, defaultTargetLaunch, renderPlanReason,
} from '../../src/spine/graph-plan.js';

const NOW = '2026-09-11T12:00:00.000Z';
const brief = (over: Record<string, unknown> = {}) => ({
  collection_name: 'Waffle Knit Capsule',
  line: 'mens',
  brief_text: 'A four-piece capsule built on waffle knit, PFD so we dye it in-house in Chicago.',
  ...over,
});

describe('validateDispatchPlan', () => {
  it('accepts a minimal one-brief plan and fills season + target_launch from the clock', () => {
    const r = validateDispatchPlan({ summary: 'One capsule', briefs: [brief()] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.briefs).toHaveLength(1);
    expect(r.plan.briefs[0]!.season).toBe('Winter 2026');
    expect(r.plan.briefs[0]!.target_launch).toBe('2026-11-06');
    expect(r.plan.briefs[0]!.persona).toBe('all');
    expect(r.plan.vendor_contacts).toEqual([]);
    expect(r.plan.run_requests).toEqual([]);
  });

  it('expands line "both" into one mens brief and one womens brief, mens first', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [brief({ line: 'both' })] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.briefs.map((b) => b.line)).toEqual(['mens', 'womens']);
    expect(r.plan.briefs[0]!.collection_name).toBe('Waffle Knit Capsule');
    expect(r.plan.briefs[1]!.collection_name).toBe('Waffle Knit Capsule');
  });

  it('defaults a missing line to both', () => {
    const b = brief(); delete (b as Record<string, unknown>).line;
    const r = validateDispatchPlan({ summary: 's', briefs: [b] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.briefs.map((b2) => b2.line)).toEqual(['mens', 'womens']);
  });

  it('rejects a plan where all three lists are empty', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [], vendor_contacts: [], run_requests: [] }, NOW);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('at least one') });
  });

  it('rejects brief_text under 40 chars', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [brief({ brief_text: 'too short' })] }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('brief_text');
  });

  it('rejects fabric_catalog set from chat', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [brief({ fabric_catalog: 'carr-textile' })] }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('fabric_catalog');
  });

  it('rejects a price_ladder entry outside value/core/premium', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [brief({ price_ladder: ['core', 'luxury'] })] }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('price_ladder');
  });

  it('de-duplicates a price_ladder and keeps it in ladder order', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [brief({ price_ladder: ['premium', 'core', 'premium'] })] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.briefs[0]!.price_ladder).toEqual(['core', 'premium']);
  });

  it('rejects product_count outside 1..8', () => {
    expect(validateDispatchPlan({ summary: 's', briefs: [brief({ product_count: 0 })] }, NOW).ok).toBe(false);
    expect(validateDispatchPlan({ summary: 's', briefs: [brief({ product_count: 9 })] }, NOW).ok).toBe(false);
    expect(validateDispatchPlan({ summary: 's', briefs: [brief({ product_count: 8 })] }, NOW).ok).toBe(true);
  });

  it('rejects a dye_program outside the two names', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [brief({ dye_program: 'reactive' })] }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('dye_program');
  });

  it('rejects a target_launch that is not YYYY-MM-DD', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [brief({ target_launch: 'November' })] }, NOW);
    expect(r.ok).toBe(false);
  });

  it('names the offending brief by its position in the raw list', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [brief(), brief({ brief_text: 'nope' })] }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('brief 2');
  });

  it('accepts a vendor-contact-only plan and keeps a well-formed email', () => {
    const r = validateDispatchPlan({
      summary: 'Add Ned',
      vendor_contacts: [{ vendor_name: 'American Fabrics International', contact_name: 'Ned Pilchman', email: 'marteva@hotmail.com', sells: ['waffle knit'] }],
    }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.vendor_contacts[0]!.email).toBe('marteva@hotmail.com');
    expect(r.plan.vendor_contacts[0]!.phone).toBeNull();
    expect(r.plan.briefs).toEqual([]);
  });

  it('rejects a vendor contact whose email does not look like an email', () => {
    const r = validateDispatchPlan({ summary: 's', vendor_contacts: [{ vendor_name: 'X', email: 'ned at hotmail' }] }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('email');
  });

  it('rejects a run_request with a blank reason', () => {
    const r = validateDispatchPlan({ summary: 's', run_requests: [{ agent: 'finance', reason: '  ' }] }, NOW);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-object plan and a missing summary', () => {
    expect(validateDispatchPlan(null, NOW).ok).toBe(false);
    expect(validateDispatchPlan({ briefs: [brief()] }, NOW).ok).toBe(false);
  });

  it('rejects a briefs value that is not an array', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: 'waffle knit' }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('briefs');
  });
});

describe('season and launch defaults', () => {
  it('names the season that starts after the current date', () => {
    expect(defaultSeason('2026-09-11T12:00:00.000Z')).toBe('Winter 2026');
    expect(defaultSeason('2026-01-05T12:00:00.000Z')).toBe('Spring 2026');
    expect(defaultSeason('2026-04-05T12:00:00.000Z')).toBe('Summer 2026');
    expect(defaultSeason('2026-07-05T12:00:00.000Z')).toBe('Fall 2026');
    expect(defaultSeason('2026-11-20T12:00:00.000Z')).toBe('Spring 2027');
  });

  it('puts the target launch 8 weeks out, date only', () => {
    expect(defaultTargetLaunch('2026-09-11T12:00:00.000Z')).toBe('2026-11-06');
  });
});

const full = validateDispatchPlan({
  summary: 'Four knit concepts, both lines, fabrics from American Fabrics International, PFD.',
  briefs: [
    { collection_name: 'Waffle Knit', line: 'both', brief_text: 'A capsule built on waffle knit; PFD goods, we dye in-house in Chicago.', product_count: 4, price_ladder: ['core', 'premium'], fabric_locks: ['waffle knit'], vendor: 'american-fabrics-international', dye_program: 'pfd_house_dye' },
  ],
  vendor_contacts: [{ vendor_name: 'American Fabrics International', contact_name: 'Ned Pilchman', email: 'marteva@hotmail.com' }],
  run_requests: [{ agent: 'sourcing', reason: 'pick up the new intents tonight' }],
}, NOW);

describe('renderPlanReason', () => {
  it('renders the summary, one line per brief, per contact and per run request', () => {
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const text = renderPlanReason(full.plan, { mens: 3, womens: 2 });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Four knit concepts, both lines, fabrics from American Fabrics International, PFD.');
    expect(lines[1]).toBe('Brief: Waffle Knit — mens, 4 pieces, core/premium, fabrics: waffle knit, vendor: american-fabrics-international, dye: PFD (we dye in-house), launch 2026-11-06');
    expect(lines[2]).toContain('Brief: Waffle Knit — womens');
    expect(lines[3]).toBe('Contact: American Fabrics International — Ned Pilchman <marteva@hotmail.com>');
    expect(lines[4]).toBe('Run: sourcing — pick up the new intents tonight');
    expect(lines[5]).toBe('Estimated 5 designer runs (2 briefs × approved personas).');
  });

  it('says "per approved persona" when the persona counts are unavailable', () => {
    if (!full.ok) return;
    const text = renderPlanReason(full.plan, null);
    expect(text.split('\n').pop()).toBe('Estimated 2 briefs × per approved persona designer runs.');
  });

  it('omits the optional segments a brief does not carry', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [{ collection_name: 'Plain', line: 'mens', brief_text: 'A plain capsule with nothing optional set at all on it.' }] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const line = renderPlanReason(r.plan, { mens: 1, womens: 1 }).split('\n')[1]!;
    expect(line).toBe('Brief: Plain — mens, launch 2026-11-06');
  });

  it('names a vendor-dyed program differently from PFD', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [{ collection_name: 'Plain', line: 'mens', brief_text: 'A plain capsule with nothing optional set at all on it.', dye_program: 'vendor_dyed' }] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renderPlanReason(r.plan, null).split('\n')[1]).toContain('dye: vendor-dyed');
  });

  it('renders a contact with no email and a contact with no name', () => {
    const r = validateDispatchPlan({ summary: 's', vendor_contacts: [{ vendor_name: 'No Mail Co' }, { vendor_name: 'Mail Co', email: 'a@b.com' }] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = renderPlanReason(r.plan, { mens: 1, womens: 1 }).split('\n');
    expect(lines[1]).toBe('Contact: No Mail Co — no email on file');
    expect(lines[2]).toBe('Contact: Mail Co — <a@b.com>');
  });

  it('omits the estimate line entirely when the plan has no briefs', () => {
    const r = validateDispatchPlan({ summary: 's', run_requests: [{ agent: 'finance', reason: 'cash check' }] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renderPlanReason(r.plan, { mens: 1, womens: 1 })).toBe('s\nRun: finance — cash check');
  });

  it('never exceeds 2000 chars even with eight briefs', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ collection_name: `Concept ${i} with a fairly long name`, line: 'both', brief_text: 'x'.repeat(200), product_count: 4, price_ladder: ['core'], fabric_locks: ['a', 'b'], vendor: 'american-fabrics-international', dye_program: 'pfd_house_dye' }));
    const r = validateDispatchPlan({ summary: 'z'.repeat(200), briefs: many }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = renderPlanReason(r.plan, { mens: 3, womens: 2 });
    expect(r.plan.briefs).toHaveLength(8);
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('drops overflowing brief lines for a counted remainder rather than truncating mid-line', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ collection_name: `Concept ${i}`, line: 'both', brief_text: 'x'.repeat(60), fabric_locks: Array.from({ length: 5 }, (_2, j) => `fabric ${j} ${'f'.repeat(60)}`) }));
    const r = validateDispatchPlan({ summary: 'z', briefs: many }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = renderPlanReason(r.plan, null);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/…and \d+ more briefs/);
    // The kept lines are whole: none ends mid-word before "launch".
    for (const line of text.split('\n').filter((l) => l.startsWith('Brief: '))) {
      expect(line).toContain('launch 2026-11-06');
    }
    expect(text.split('\n').pop()).toBe('Estimated 8 briefs × per approved persona designer runs.');
  });
});

describe('plan size bounds', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => brief({ collection_name: `C${i}`, line: 'mens' }));

  it('accepts 12 briefs after the both expansion and rejects 14', () => {
    expect(validateDispatchPlan({ summary: 's', briefs: many(12) }, NOW).ok).toBe(true);
    const r = validateDispatchPlan({ summary: 's', briefs: Array.from({ length: 7 }, (_, i) => brief({ collection_name: `C${i}`, line: 'both' })) }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('12 briefs');
    expect(r.error).toContain('14');
  });

  it('accepts 6 both-briefs, which expand to exactly 12', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: Array.from({ length: 6 }, (_, i) => brief({ collection_name: `C${i}`, line: 'both' })) }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.briefs).toHaveLength(12);
  });

  it('accepts 10 vendor contacts and rejects 11', () => {
    const c = (n: number) => Array.from({ length: n }, (_, i) => ({ vendor_name: `V${i}` }));
    expect(validateDispatchPlan({ summary: 's', vendor_contacts: c(10) }, NOW).ok).toBe(true);
    expect(validateDispatchPlan({ summary: 's', vendor_contacts: c(11) }, NOW).ok).toBe(false);
  });

  it('accepts 5 run requests and rejects 6', () => {
    const q = (n: number) => Array.from({ length: n }, (_, i) => ({ agent: `a${i}`, reason: 'r' }));
    expect(validateDispatchPlan({ summary: 's', run_requests: q(5) }, NOW).ok).toBe(true);
    expect(validateDispatchPlan({ summary: 's', run_requests: q(6) }, NOW).ok).toBe(false);
  });

  it('accepts 12 fabric_locks and rejects 13', () => {
    const f = (n: number) => Array.from({ length: n }, (_, i) => `fabric ${i}`);
    expect(validateDispatchPlan({ summary: 's', briefs: [brief({ fabric_locks: f(12) })] }, NOW).ok).toBe(true);
    const r = validateDispatchPlan({ summary: 's', briefs: [brief({ fabric_locks: f(13) })] }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('fabric_locks');
  });

  it('accepts 20 sells phrases and rejects 21', () => {
    const sells = (n: number) => Array.from({ length: n }, (_, i) => `knit ${i}`);
    expect(validateDispatchPlan({ summary: 's', vendor_contacts: [{ vendor_name: 'V', sells: sells(20) }] }, NOW).ok).toBe(true);
    const r = validateDispatchPlan({ summary: 's', vendor_contacts: [{ vendor_name: 'V', sells: sells(21) }] }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('sells');
  });

  it('renders a maximum-size plan of long strings inside the 2000-char reason cap', () => {
    const long = 'L'.repeat(400);
    const r = validateDispatchPlan({
      summary: 'z'.repeat(200),
      briefs: Array.from({ length: 6 }, () => brief({ line: 'both', collection_name: 'N'.repeat(120), fabric_locks: Array.from({ length: 12 }, () => long), vendor: 'v'.repeat(120) })),
      vendor_contacts: Array.from({ length: 10 }, () => ({ vendor_name: 'V'.repeat(120), contact_name: 'C'.repeat(120), email: `${'e'.repeat(200)}@x.com` })),
      run_requests: Array.from({ length: 5 }, () => ({ agent: 'a'.repeat(120), reason: 'r'.repeat(300) })),
    }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = renderPlanReason(r.plan, { mens: 3, womens: 2 });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain('…and 12 more briefs');
    expect(text).toContain('more vendor contacts');
    expect(text.split('\n')[0]).toBe('z'.repeat(200));
    expect(text.split('\n').pop()).toBe('Estimated 30 designer runs (12 briefs × approved personas).');
  });
});

describe('renderPlanReason options', () => {
  it('shows a truncated brief_text line under each brief when the plan is small', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [brief({ line: 'mens', brief_text: `${'w'.repeat(300)}` })] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = renderPlanReason(r.plan, null, { briefTextMaxBriefs: 3 }).split('\n');
    expect(lines[1]).toMatch(/^Brief: /);
    expect(lines[2]!.startsWith('  ')).toBe(true);
    expect(lines[2]!.length).toBeLessThanOrEqual(142);
    expect(lines[2]).toContain('…');
  });

  it('omits the brief_text lines once the plan is bigger than the threshold', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: Array.from({ length: 4 }, (_, i) => brief({ collection_name: `C${i}`, line: 'mens' })) }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = renderPlanReason(r.plan, null, { briefTextMaxBriefs: 3 }).split('\n');
    expect(lines.filter((l) => l.startsWith('  '))).toEqual([]);
  });

  it('uses an explicit designRuns count when no persona counts are available', () => {
    const r = validateDispatchPlan({ summary: 's', briefs: [brief({ line: 'both' })] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(renderPlanReason(r.plan, null, { designRuns: 16 }).split('\n').pop())
      .toBe('Estimated 16 designer runs (2 briefs × approved personas).');
    expect(renderPlanReason(r.plan, null).split('\n').pop())
      .toBe('Estimated 2 briefs × per approved persona designer runs.');
  });
});
