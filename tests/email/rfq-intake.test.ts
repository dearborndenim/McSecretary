import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertRfqMessage, emailDomain, parseIntents } from '../../src/db/rfq-queries.js';
import {
  matchRfqReply, extractRfqTag, parseRfqExtraction, buildVendorQuoteBody, vendorNameFor,
  processRfqReply, setRfqIntakeHandler, getRfqIntakeHandler, buildExtractionPrompt, classifyRfqReply,
  type RfqExtraction, type RfqIntakeDeps, type RfqMatch, type RfqOption, type VendorQuoteBody,
} from '../../src/email/rfq-intake.js';
import type { RawEmail } from '../../src/email/types.js';
import type { ProposalInput, SpineEventInput } from '../../src/spine/types.js';

const NOW = '2026-09-10T12:00:00.000Z';
const RFQ_ID = 'linen-spring27-carr-20260910';

function reply(over: Partial<RawEmail> = {}): RawEmail {
  return {
    id: 'msg-1',
    account: 'rob@dearborndenim.com',
    sender: 'sales@carrtextiles.example',
    senderName: 'Carr Textiles',
    subject: `RE: [DD-RFQ-${RFQ_ID}] Fabric request — Dearborn Denim, Spring 27`,
    bodyPreview: 'Here are three linens',
    body: 'Style CT-4410, $6.75/yd, 5.5 oz, 57", 100% linen, 300 yd minimum, 21 days.',
    receivedAt: '2026-09-12T08:00:00.000Z',
    threadId: 'thread-1',
    isRead: false,
    ...over,
  };
}

function seedSend(db: Database.Database, over: Partial<Parameters<typeof insertRfqMessage>[1]> = {}): void {
  insertRfqMessage(db, {
    rfq_id: RFQ_ID,
    vendor_email: 'sales@carrtextiles.example',
    subject: `[DD-RFQ-${RFQ_ID}] Fabric request`,
    graph_message_id: 'g-1',
    sent_at: '2026-09-10T12:00:00.000Z',
    proposal_id: 12,
    brand_id: 'dearborn-denim',
    intents: 'fi_1,fi_2',
    ...over,
  });
}

describe('emailDomain / parseIntents', () => {
  it.each([
    ['sales@carrtextiles.example', 'carrtextiles.example'],
    ['Sales@CarrTextiles.Example', 'carrtextiles.example'],
    ['not-an-address', ''],
    ['trailing@', ''],
  ])('%s → %s', (input, expected) => expect(emailDomain(input)).toBe(expected));

  it('splits an intents CSV and drops blanks', () => {
    expect(parseIntents('fi_1, fi_2 ,,fi_3')).toEqual(['fi_1', 'fi_2', 'fi_3']);
    expect(parseIntents('')).toEqual([]);
    expect(parseIntents(null)).toEqual([]);
  });
});

describe('extractRfqTag', () => {
  it('finds the tag in a reply subject, whatever the prefix', () => {
    expect(extractRfqTag('Re: Fwd: [DD-RFQ-abc-123] Fabric request')).toBe('abc-123');
  });
  it('falls through the given texts in order and returns null when absent', () => {
    expect(extractRfqTag(null, 'no tag', `body [DD-RFQ-${RFQ_ID}] here`)).toBe(RFQ_ID);
    expect(extractRfqTag('nothing', undefined)).toBeNull();
  });
});

describe('matchRfqReply', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('returns null when nothing was ever sent', () => {
    expect(matchRfqReply(db, reply(), NOW)).toBeNull();
  });

  it('matches by the [DD-RFQ-…] subject tag and carries the intents through', () => {
    seedSend(db);
    const m = matchRfqReply(db, reply(), '2026-09-12T09:00:00.000Z');
    expect(m).toMatchObject({
      rfq_id: RFQ_ID, matched_by: 'tag', intents: ['fi_1', 'fi_2'],
      brand_id: 'dearborn-denim', proposal_id: 12,
    });
  });

  it('matches by the tag even when the vendor answers from another mailbox', () => {
    seedSend(db);
    const m = matchRfqReply(db, reply({ sender: 'design@somewhere-else.example' }), '2026-09-12T09:00:00.000Z');
    expect(m?.matched_by).toBe('tag');
  });

  it('matches by sender domain when the vendor strips the tag', () => {
    seedSend(db);
    const m = matchRfqReply(db, reply({ subject: 'Our linen range', bodyPreview: 'attached' }), '2026-09-12T09:00:00.000Z');
    expect(m).toMatchObject({ rfq_id: RFQ_ID, matched_by: 'domain' });
  });

  it('does not match a domain outside the 60-day window', () => {
    seedSend(db, { sent_at: '2026-06-01T00:00:00.000Z' });
    const m = matchRfqReply(db, reply({ subject: 'Our linen range', bodyPreview: '' }), '2026-09-12T09:00:00.000Z');
    expect(m).toBeNull();
  });

  it('does not match an unrelated sender', () => {
    seedSend(db);
    const m = matchRfqReply(db, reply({ subject: 'newsletter', bodyPreview: '', sender: 'news@random.example' }), NOW);
    expect(m).toBeNull();
  });

  it('takes the most recent send for a domain that was mailed twice', () => {
    seedSend(db, { rfq_id: 'old-rfq', sent_at: '2026-08-01T00:00:00.000Z', intents: 'fi_9' });
    seedSend(db, { rfq_id: 'new-rfq', sent_at: '2026-09-09T00:00:00.000Z', intents: 'fi_7' });
    const m = matchRfqReply(db, reply({ subject: 'no tag', bodyPreview: '' }), '2026-09-10T00:00:00.000Z');
    expect(m).toMatchObject({ rfq_id: 'new-rfq', intents: ['fi_7'] });
  });
});

describe('parseRfqExtraction', () => {
  const option = {
    style_number: 'CT-4410', price_per_yard_usd: 6.75, weight_oz: 5.5, width_in: 57,
    content: '100% linen', moq: 300, moq_unit: 'yards', lead_days: 21, notes: null,
  };

  it('keeps the option verbatim and caps the excerpt at 600 chars', () => {
    const raw = JSON.stringify({ options: [option], unparsed_excerpt: 'x'.repeat(900) });
    const parsed = parseRfqExtraction(raw);
    expect(parsed.options).toEqual([option]);
    expect(parsed.unparsed_excerpt).toHaveLength(600);
  });

  it('normalizes missing/NaN numbers and blank strings to null', () => {
    const raw = JSON.stringify({
      options: [{ ...option, price_per_yard_usd: null, content: '   ', moq_unit: undefined }],
      unparsed_excerpt: '',
    });
    expect(parseRfqExtraction(raw).options[0]).toMatchObject({
      price_per_yard_usd: null, content: null, moq_unit: null,
    });
  });

  it('drops an option with no style number — nothing downstream can name it', () => {
    const raw = JSON.stringify({ options: [{ ...option, style_number: '' }, option], unparsed_excerpt: '' });
    expect(parseRfqExtraction(raw).options).toHaveLength(1);
  });

  it('accepts an empty options array (an out-of-office)', () => {
    expect(parseRfqExtraction('{"options":[],"unparsed_excerpt":"Away until Monday"}')).toEqual({
      options: [], unparsed_excerpt: 'Away until Monday',
    });
  });

  it('throws on a response that is not the agreed shape', () => {
    expect(() => parseRfqExtraction('{"options":"three"}')).toThrow(/options is not an array/);
    expect(() => parseRfqExtraction('[]')).toThrow(/not an object/);
  });
});

describe('buildVendorQuoteBody', () => {
  const option: RfqOption = {
    style_number: 'CT-4410', price_per_yard_usd: 6.75, weight_oz: 5.5, width_in: 57,
    content: '100% linen', moq: 300, moq_unit: 'yards', lead_days: 21, notes: 'greige available',
  };

  it('is the product-dev vendor-quote shape, priced and quoted', () => {
    expect(buildVendorQuoteBody(option, {
      fabricIntentId: 'fi_1', vendorName: 'Carr Textiles', rfqId: RFQ_ID,
      attachments: [{ url: 'https://mcs.example/files/rfq/aaaa/sw.png', name: 'sw.png', kind: 'image' }],
    })).toEqual({
      fabricIntentId: 'fi_1',
      vendorName: 'Carr Textiles',
      description: 'CT-4410 — Carr Textiles',
      pricePerUnit: 6.75,
      unit: 'yard',
      moq: 300,
      leadDays: 21,
      priceStatus: 'quoted',
      rfqId: RFQ_ID,
      styleNumber: 'CT-4410',
      widthIn: 57,
      weightOz: 5.5,
      attachments: [{ url: 'https://mcs.example/files/rfq/aaaa/sw.png', name: 'sw.png', kind: 'image' }],
    });
  });

  it('passes unquoted fields through as null rather than inventing them', () => {
    const body = buildVendorQuoteBody(
      { ...option, price_per_yard_usd: null, moq: null, lead_days: null, width_in: null, weight_oz: null },
      { fabricIntentId: 'fi_1', vendorName: 'V', rfqId: RFQ_ID, attachments: [] },
    );
    expect(body).toMatchObject({ pricePerUnit: null, moq: null, leadDays: null, widthIn: null, weightOz: null });
  });
});

describe('vendorNameFor', () => {
  const match = { vendor_domain: 'carrtextiles.example' } as RfqMatch;
  it('uses the signed display name', () => {
    expect(vendorNameFor(reply(), match)).toBe('Carr Textiles');
  });
  it('falls back to the domain when the display name is just the address', () => {
    expect(vendorNameFor(reply({ senderName: 'sales@carrtextiles.example' }), match)).toBe('carrtextiles.example');
    expect(vendorNameFor(reply({ senderName: '' }), match)).toBe('carrtextiles.example');
  });
});

describe('buildExtractionPrompt', () => {
  it('gives the model the sender, subject and full body', () => {
    const p = buildExtractionPrompt(reply());
    expect(p).toContain('Carr Textiles <sales@carrtextiles.example>');
    expect(p).toContain(RFQ_ID);
    expect(p).toContain('Style CT-4410');
  });
});

// ---------------------------------------------------------------------------

const MATCH: RfqMatch = {
  rfq_id: RFQ_ID,
  vendor_email: 'sales@carrtextiles.example',
  vendor_domain: 'carrtextiles.example',
  intents: ['fi_1', 'fi_2'],
  proposal_id: 12,
  brand_id: 'dearborn-denim',
  matched_by: 'tag',
};

const OPTION: RfqOption = {
  style_number: 'CT-4410', price_per_yard_usd: 6.75, weight_oz: 5.5, width_in: 57,
  content: '100% linen', moq: 300, moq_unit: 'yards', lead_days: 21, notes: null,
};

interface Harness {
  deps: RfqIntakeDeps;
  quotes: VendorQuoteBody[];
  proposals: ProposalInput[];
  events: SpineEventInput[];
}

function harness(over: Partial<RfqIntakeDeps> & { extraction?: RfqExtraction } = {}): Harness {
  const quotes: VendorQuoteBody[] = [];
  const proposals: ProposalInput[] = [];
  const events: SpineEventInput[] = [];
  let n = 0;
  const deps: RfqIntakeDeps = {
    db: null as unknown as Database.Database, // processRfqReply never touches the db itself
    now: () => NOW,
    brandId: 'dearborn-denim',
    extract: async () => over.extraction ?? { options: [OPTION], unparsed_excerpt: '' },
    saveAttachments: async () => [{ url: 'https://mcs.example/files/rfq/abc/sw.png', name: 'sw.png', kind: 'image' }],
    postVendorQuote: async (body) => { quotes.push(body); n += 1; return { ok: true, id: `q${n}` }; },
    file: async (input) => { proposals.push(input); return { id: 1, routed: 'card' }; },
    emitEvent: (e) => { events.push(e); },
    ...over,
  };
  return { deps, quotes, proposals, events };
}

describe('processRfqReply', () => {
  it('files every option against every intent on the RFQ and emits vendor_quote_received', async () => {
    const h = harness();
    const r = await processRfqReply(reply(), MATCH, h.deps);

    expect(h.quotes.map((q) => q.fabricIntentId)).toEqual(['fi_1', 'fi_2']);
    expect(h.quotes[0]).toMatchObject({
      styleNumber: 'CT-4410', pricePerUnit: 6.75, priceStatus: 'quoted', unit: 'yard', rfqId: RFQ_ID,
      description: 'CT-4410 — Carr Textiles',
      attachments: [{ url: 'https://mcs.example/files/rfq/abc/sw.png', name: 'sw.png', kind: 'image' }],
    });
    expect(r.quotes).toEqual(['q1', 'q2']);
    expect(h.proposals).toEqual([]);
    expect(h.events).toEqual([{
      source_hand: 'mcsecretary',
      brand_id: 'dearborn-denim',
      event_type: 'vendor_quote_received',
      payload: { rfq_id: RFQ_ID, vendor: 'Carr Textiles', quotes: ['q1', 'q2'], intents: ['fi_1', 'fi_2'] },
      urgent: true,
    }]);
    expect(r.summary).toMatch(/2 quote\(s\) filed on 2 intent\(s\)/);
  });

  it('counts a 2xx with no id as filed so the event still wakes Sourcing', async () => {
    const h = harness({ postVendorQuote: async () => ({ ok: true, id: null }) });
    const r = await processRfqReply(reply(), { ...MATCH, intents: ['fi_1'] }, h.deps);
    expect(r.filed).toBe(1);
    expect(r.quotes).toEqual([]);
    expect(h.events).toHaveLength(1);
    expect(h.proposals).toEqual([]);
  });

  it('files a notes card as mcsecretary when the reply yields no options', async () => {
    const h = harness({ extraction: { options: [], unparsed_excerpt: 'Out of office until 22 Sept.' } });
    const r = await processRfqReply(reply(), MATCH, h.deps);

    expect(h.quotes).toEqual([]);
    expect(h.events).toEqual([]);
    expect(r.noted).toBe(true);
    expect(h.proposals).toHaveLength(1);
    const p = h.proposals[0]!;
    expect(p.agent).toBe('mcsecretary');
    expect(p.action_type).toBe('rfq_reply_unparsed');
    expect(p.brand_id).toBe('dearborn-denim');
    expect(p.level_required).toBe(1);
    expect(p.cost_usd).toBe(0);
    expect(p.action_payload).toMatchObject({ hand: 'notes', method: 'POST', path: '/note' });
    const body = p.action_payload.body as { title: string; summary: string; details: Record<string, unknown> };
    expect(body.title).toMatch(/RFQ reply needs a human — Carr Textiles/);
    expect(body.summary).toContain('Out of office until 22 Sept.');
    expect(body.title.length).toBeLessThanOrEqual(120);
    expect(body.summary.length).toBeLessThanOrEqual(2000);
    expect(body.details).toMatchObject({ rfq_id: RFQ_ID, from: 'sales@carrtextiles.example' });
    expect(p.expires_at).toBe('2026-09-12T12:00:00.000Z');
  });

  it('cards the reply when the RFQ carried no intents to file against', async () => {
    const h = harness();
    const r = await processRfqReply(reply(), { ...MATCH, intents: [] }, h.deps);
    expect(h.quotes).toEqual([]);
    expect(r.noted).toBe(true);
    expect((h.proposals[0]!.action_payload.body as { summary: string }).summary)
      .toMatch(/no fabric intents to file them against/);
  });

  it('cards the reply and reports the error when product-dev rejects every quote', async () => {
    const h = harness({ postVendorQuote: async () => ({ ok: false, id: null, error: 'product-dev 422: unknown intent' }) });
    const r = await processRfqReply(reply(), MATCH, h.deps);
    expect(r.filed).toBe(0);
    expect(r.errors.join(' ')).toMatch(/422/);
    expect(h.proposals).toHaveLength(1);
    expect(h.events).toEqual([]);
  });

  it('survives an extraction failure by carding it instead of throwing', async () => {
    const h = harness({ extract: async () => { throw new Error('anthropic 529'); } });
    const r = await processRfqReply(reply(), MATCH, h.deps);
    expect(r.errors.join(' ')).toMatch(/anthropic 529/);
    expect(h.proposals).toHaveLength(1);
  });

  it('still files quotes when the attachments could not be saved', async () => {
    const h = harness({ saveAttachments: async () => { throw new Error('graph 503'); } });
    const r = await processRfqReply(reply(), { ...MATCH, intents: ['fi_1'] }, h.deps);
    expect(h.quotes[0]!.attachments).toEqual([]);
    expect(r.quotes).toEqual(['q1']);
    expect(r.errors.join(' ')).toMatch(/graph 503/);
  });

  it('caps the cross product so one price list cannot flood product-dev', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...OPTION, style_number: `CT-${i}` }));
    const h = harness({ extraction: { options: many, unparsed_excerpt: '' } });
    await processRfqReply(reply(), { ...MATCH, intents: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, h.deps);
    expect(h.quotes).toHaveLength(20);
    expect(new Set(h.quotes.map((q) => q.fabricIntentId)).size).toBeLessThanOrEqual(5);
  });
});

describe('rfq intake handler registry', () => {
  afterEach(() => setRfqIntakeHandler(null));

  it('is unset by default so triage keeps the ordinary path', () => {
    expect(getRfqIntakeHandler()).toBeNull();
  });

  it('returns what index.ts registered', async () => {
    const fn = vi.fn();
    setRfqIntakeHandler(fn as never);
    expect(getRfqIntakeHandler()).toBe(fn);
  });
});

describe('classifyRfqReply (the triage seam)', () => {
  it('labels the reply rfq_reply for review and surfaces the intake summary', async () => {
    const errors: string[] = [];
    const c = await classifyRfqReply(reply(), MATCH, async () => ({
      rfq_id: RFQ_ID, vendor: 'Carr Textiles', options: 2, quotes: ['q1'], filed: 1,
      intents: ['fi_1'], noted: false, summary: 'two options, one quote filed',
      suggestedAction: 'Sourcing will rank the options; pick one in the gallery.', errors: [],
    }), errors);
    expect(c).toMatchObject({
      id: 'msg-1',
      category: 'rfq_reply',
      urgency: 'high',
      actionNeeded: 'review_required',
      senderImportance: 'vendor',
      confidence: 1,
      summary: 'two options, one quote filed',
    });
    expect(errors).toEqual([]);
  });

  it('forwards intake errors to the run error list without losing the email', async () => {
    const errors: string[] = [];
    const c = await classifyRfqReply(reply(), MATCH, async () => ({
      rfq_id: RFQ_ID, vendor: 'Carr', options: 1, quotes: [], filed: 0, intents: ['fi_1'],
      noted: true, summary: 's', suggestedAction: 'a', errors: ['product-dev 422'],
    }), errors);
    expect(c.category).toBe('rfq_reply');
    expect(errors).toEqual([`RFQ ${RFQ_ID}: product-dev 422`]);
  });

  it('still returns a classified row when the intake throws', async () => {
    const errors: string[] = [];
    const c = await classifyRfqReply(reply(), MATCH, async () => { throw new Error('db locked'); }, errors);
    expect(c.category).toBe('rfq_reply');
    expect(c.summary).toMatch(/could not be processed: db locked/);
    expect(errors[0]).toMatch(/RFQ intake failed for msg-1: db locked/);
  });
});
