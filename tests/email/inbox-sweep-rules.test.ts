import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyDeterministicRules,
  COMPANY_DOMAINS,
  decideAction,
  fromGraphMessage,
  isAutomatedSender,
  isProtectedSender,
  parseSweepMode,
  unsubscribeEligible,
  type RuleContext,
  type SweepClassification,
  type SweepMessage,
  type UnsubscribeInput,
} from '../../src/email/inbox-sweep-rules.js';

const ROB = 'rob@dearborndenim.com';

function fixture(name: string, mailbox = ROB): SweepMessage {
  const raw = JSON.parse(readFileSync(new URL(`../fixtures/inbox-sweep/${name}.json`, import.meta.url), 'utf8'));
  return fromGraphMessage(raw, mailbox);
}

const ctx: RuleContext = { isRfqReply: false, mmiReportSenders: new Set(), companyDomains: COMPANY_DOMAINS };

function cls(over: Partial<SweepClassification>): SweepClassification {
  return { index: 1, lane: 'keep', bot: 'none', key_facts: 'facts', urgent_today: false, confidence: 0.95, ...over };
}

function unsub(m: SweepMessage, over: Partial<UnsubscribeInput> = {}): ReturnType<typeof unsubscribeEligible> {
  return unsubscribeEligible({
    lane: 'promotions',
    sender: m.sender,
    headers: m.headers,
    companyDomains: COMPANY_DOMAINS,
    deniedAddresses: new Set([ROB]),
    knownCorrespondent: false,
    engaged: false,
    ...over,
  });
}

describe('fromGraphMessage', () => {
  it('maps sender, recipients and headers, lower-casing addresses', () => {
    const m = fixture('gina-vendor-reply');
    expect(m.sender).toBe('jack.smithson@candiani-usa.example');
    expect(m.to).toEqual(['gina@dearborndenim.com']);
    expect(m.cc).toEqual([ROB]);
    expect(m.mailbox).toBe(ROB);
    expect(m.headers?.some((h) => h.name === 'Message-ID')).toBe(true);
  });

  it('keeps headers null when Graph did not return them', () => {
    const raw = JSON.parse(readFileSync(new URL('../fixtures/inbox-sweep/dla-rfq.json', import.meta.url), 'utf8'));
    delete raw.internetMessageHeaders;
    expect(fromGraphMessage(raw, ROB).headers).toBeNull();
  });
});

describe('deterministic rules', () => {
  it('files a DMARC aggregate report without a model call', () => {
    expect(applyDeterministicRules(fixture('dmarc-report'), ctx)).toEqual({ rule: 'dmarc', folder: 'DMARC Reports', classify: false });
  });

  it('archives a vendor reply on a Gina thread (Rob on Cc) and asks the classifier about a handoff', () => {
    expect(applyDeterministicRules(fixture('gina-vendor-reply'), ctx)).toEqual({ rule: 'gina_thread', folder: 'archive', classify: true });
  });

  it('does not treat a Gina-thread message addressed To Rob as a Gina thread', () => {
    const m = fixture('gina-vendor-reply');
    expect(applyDeterministicRules({ ...m, to: ['gina@dearborndenim.com', ROB], cc: [] }, ctx)).toBeNull();
  });

  it("archives Gina's own copy, but classifies Gina writing to Rob directly", () => {
    const copy = { ...fixture('promo-mailto-only'), sender: 'gina@dearborndenim.com', to: ['vendor@mill.example'], cc: [ROB] };
    expect(applyDeterministicRules(copy, ctx)?.rule).toBe('gina_copy');
    expect(applyDeterministicRules({ ...copy, to: [ROB], cc: [] }, ctx)).toBeNull();
  });

  it('files a known MMI report sender only when it looks automated and is not company staff or Gina', () => {
    const base = fixture('promo-mailto-only');
    const seen = (sender: string) => ({ ...ctx, mmiReportSenders: new Set([sender]) });
    const rule = (sender: string, headers = base.headers) => applyDeterministicRules({ ...base, sender, headers }, seen(sender))?.rule;
    expect(rule('noreply@erp-cloud.example')).toBe('mmi_report');
    // A person filed there twice: no automated signal, so classified like any other mail.
    expect(rule('jane.doe@erp-cloud.example')).toBeUndefined();
    expect(rule('jane.doe@erp-cloud.example', [...base.headers!, { name: 'Auto-Submitted', value: 'auto-generated' }])).toBe('mmi_report');
    expect(rule('jane.doe@erp-cloud.example', [...base.headers!, { name: 'Precedence', value: 'bulk' }])).toBe('mmi_report');
    expect(rule('jane.doe@erp-cloud.example', [...base.headers!, { name: 'Auto-Submitted', value: 'no' }])).toBeUndefined();
    expect(rule('reports@mcmillan-manufacturing.com')).not.toBe('mmi_report');
    expect(rule('gina@dearborndenim.com')).not.toBe('mmi_report');
  });

  it('recognises automated senders by local part', () => {
    const m = fixture('promo-mailto-only');
    expect(isAutomatedSender({ ...m, sender: 'do-not-reply@x.example', headers: null })).toBe(true);
    expect(isAutomatedSender({ ...m, sender: 'notifications@x.example', headers: null })).toBe(true);
    expect(isAutomatedSender({ ...m, sender: 'reportingmanager.jones@x.example', headers: null })).toBe(false);
  });

  it('never moves an RFQ reply (a move re-ids it and the RFQ intake would file it twice)', () => {
    const hit = applyDeterministicRules(fixture('gina-vendor-reply'), { ...ctx, isRfqReply: true });
    expect(hit).toEqual({ rule: 'rfq_reply', folder: null, classify: false });
    expect(decideAction(hit, cls({ lane: 'fyi' })).folder).toBeNull();
  });

  it('leaves everything else to the classifier', () => {
    for (const name of ['promo-one-click', 'bank-alert', 'phish-fake-invoice', 'dla-rfq']) {
      expect(applyDeterministicRules(fixture(name), ctx)).toBeNull();
    }
  });
});

describe('decideAction', () => {
  it('keeps mail with no answer or low confidence in the inbox', () => {
    expect(decideAction(null, undefined)).toMatchObject({ lane: 'keep', folder: null, handoffBot: null });
    expect(decideAction(null, cls({ lane: 'promotions', confidence: 0.79 })).folder).toBeNull();
  });

  it('maps confident lanes to folders, handoffs and tell-Robert', () => {
    expect(decideAction(null, cls({ lane: 'promotions' })).folder).toBe('Promotions');
    expect(decideAction(null, cls({ lane: 'fyi' })).folder).toBe('archive');
    expect(decideAction(null, cls({ lane: 'junk' }), { second: cls({ lane: 'junk' }) }).folder).toBe('Sweep Junk');
    expect(decideAction(null, cls({ lane: 'phishing' }), { second: cls({ lane: 'phishing' }) }))
      .toMatchObject({ folder: 'Sweep Junk', tell: 'phishing' });
    expect(decideAction(null, cls({ lane: 'gov_bid', bot: 'General Paton Bot' })))
      .toMatchObject({ folder: 'Gov Bids', tell: 'gov_bid', handoffBot: 'General Paton Bot' });
    expect(decideAction(null, cls({ lane: 'handoff', bot: 'HR Bot' }))).toMatchObject({ folder: 'archive', handoffBot: 'HR Bot' });
  });

  it('leaves a handoff with no owner, and anything urgent today that is not junk, in the inbox', () => {
    expect(decideAction(null, cls({ lane: 'handoff', bot: 'none' })).folder).toBeNull();
    expect(decideAction(null, cls({ lane: 'fyi', urgent_today: true }))).toMatchObject({ folder: null, tell: 'urgent_today' });
  });

  it('on a Gina thread: hands an action-needing reply to its owner, Gina by default, and keeps what Rob must decide', () => {
    const rule = applyDeterministicRules(fixture('gina-vendor-reply'), ctx);
    expect(decideAction(rule, cls({ lane: 'handoff', bot: 'Purchasing Bot' }))).toMatchObject({ folder: 'archive', handoffBot: 'Purchasing Bot' });
    expect(decideAction(rule, cls({ lane: 'handoff', bot: 'none' }))).toMatchObject({ folder: 'archive', handoffBot: 'Gina' });
    expect(decideAction(rule, cls({ lane: 'fyi' }))).toMatchObject({ folder: 'archive', handoffBot: null });
    expect(decideAction(rule, cls({ lane: 'keep' })).folder).toBeNull();
    expect(decideAction(rule, cls({ lane: 'phishing' }), { second: cls({ lane: 'phishing' }) }))
      .toMatchObject({ folder: 'Sweep Junk', tell: 'phishing' });
  });

  it('on a Gina thread: no classifier answer or low confidence keeps it in the inbox', () => {
    const rule = applyDeterministicRules(fixture('gina-vendor-reply'), ctx);
    expect(decideAction(rule, undefined)).toMatchObject({ folder: null, handoffBot: null });
    expect(decideAction(rule, cls({ lane: 'handoff', bot: 'Gina', confidence: 0.5 }))).toMatchObject({ folder: null, handoffBot: null });
  });

  it('keeps junk or phishing that the single-message pass does not confirm (prompt injection guard)', () => {
    expect(decideAction(null, cls({ lane: 'junk' })).folder).toBeNull();
    expect(decideAction(null, cls({ lane: 'junk' }), { second: null }).folder).toBeNull();
    expect(decideAction(null, cls({ lane: 'junk' }), { second: cls({ lane: 'keep' }) }).folder).toBeNull();
    expect(decideAction(null, cls({ lane: 'phishing' }), { second: cls({ lane: 'phishing', confidence: 0.6 }) }).folder).toBeNull();
    // Either pass saying phishing makes it phishing.
    expect(decideAction(null, cls({ lane: 'junk' }), { second: cls({ lane: 'phishing' }) })).toMatchObject({ lane: 'phishing', tell: 'phishing' });
  });

  it('keeps government and bank senders unless it is a gov bid or both passes say phishing', () => {
    const p = { protectedSender: true };
    expect(decideAction(null, cls({ lane: 'fyi' }), p).folder).toBeNull();
    expect(decideAction(null, cls({ lane: 'promotions' }), p).folder).toBeNull();
    expect(decideAction(null, cls({ lane: 'junk' }), { ...p, second: cls({ lane: 'junk' }) }).folder).toBeNull();
    expect(decideAction(null, cls({ lane: 'junk' }), { ...p, second: cls({ lane: 'phishing' }) }).folder).toBeNull();
    expect(decideAction(null, cls({ lane: 'phishing' }), { ...p, second: cls({ lane: 'phishing' }) }).folder).toBe('Sweep Junk');
    expect(decideAction(null, cls({ lane: 'gov_bid', bot: 'General Paton Bot' }), p).folder).toBe('Gov Bids');
    expect(decideAction(null, cls({ lane: 'fyi', urgent_today: true }), p)).toMatchObject({ folder: null, tell: 'urgent_today' });
    expect(isProtectedSender('alerts@notify.wintrust.com')).toBe(true);
    expect(isProtectedSender('dibbs-rfq@dla.mil')).toBe(true);
    expect(isProtectedSender('news@mail.bestmadeco.example')).toBe(false);
  });
});

describe('unsubscribeEligible (RFC 8058 one-click only)', () => {
  it('allows a marketing sender with List-Unsubscribe-Post: One-Click and an https URI, picking the https one', () => {
    expect(unsub(fixture('promo-one-click'))).toEqual({
      ok: true,
      url: 'https://mail.bestmadeco.example/unsub/abc123?e=rob%40dearborndenim.com',
    });
  });

  it('never uses a mailto-only header', () => {
    expect(unsub(fixture('promo-mailto-only'))).toMatchObject({ ok: false });
  });

  it('refuses without the One-Click post header, even with an https URI', () => {
    const m = fixture('promo-one-click');
    const headers = m.headers!.filter((h) => h.name !== 'List-Unsubscribe-Post');
    expect(unsub({ ...m, headers })).toMatchObject({ ok: false, reason: 'no RFC 8058 one-click header' });
  });

  it('refuses every lane but promotions (junk, phishing, cold outreach, fyi)', () => {
    const m = fixture('promo-one-click');
    for (const lane of ['junk', 'phishing', 'fyi', 'handoff', 'keep', 'gov_bid']) {
      expect(unsub(m, { lane })).toMatchObject({ ok: false });
    }
  });

  it('refuses a bank even with a valid one-click header', () => {
    expect(unsub(fixture('bank-alert'))).toEqual({ ok: false, reason: 'bank or payment sender' });
    expect(unsub(fixture('promo-one-click'), { sender: 'offers@firstmidwestbank.example' })).toMatchObject({ ok: false });
    expect(unsub(fixture('promo-one-click'), { sender: 'news@shopify.com' })).toMatchObject({ ok: false });
  });

  it('refuses government senders', () => {
    for (const sender of ['dibbs-rfq@dla.mil', 'news@sam.gov', 'alerts@chicago.il.us']) {
      expect(unsub(fixture('promo-one-click'), { sender })).toEqual({ ok: false, reason: 'government sender' });
    }
  });

  it('refuses static vendor and customer domains, subdomains included', () => {
    const m = fixture('promo-one-click');
    expect(unsub(m, { sender: 'news@conedenim.com' })).toEqual({ ok: false, reason: 'known vendor or customer domain' });
    expect(unsub(m, { sender: 'promo@mail.carrtextile.com' })).toEqual({ ok: false, reason: 'known vendor or customer domain' });
    expect(unsub(m, { sender: 'vendors@vermontflannel.com' })).toMatchObject({ ok: false });
  });

  it('refuses staff, company domains, known vendors/customers and anyone Rob engaged with', () => {
    const m = fixture('promo-one-click');
    expect(unsub(m, { sender: 'merab@dearborndenim.com' })).toMatchObject({ ok: false });
    expect(unsub(m, { sender: 'news@mcmillan-manufacturing.com' })).toMatchObject({ ok: false });
    expect(unsub(m, { deniedAddresses: new Set([m.sender]) })).toMatchObject({ ok: false });
    expect(unsub(m, { knownCorrespondent: true })).toMatchObject({ ok: false });
    expect(unsub(m, { engaged: true })).toMatchObject({ ok: false });
    expect(unsub(m, { engaged: null })).toMatchObject({ ok: false, reason: 'engagement check did not complete' });
  });

  it('refuses an https URI that points at an IP, a private host or carries credentials', () => {
    const m = fixture('promo-one-click');
    const withUrl = (url: string) => m.headers!.map((h) => (h.name === 'List-Unsubscribe' ? { ...h, value: `<${url}>` } : h));
    for (const url of ['https://10.0.0.5/u', 'https://mcsecretary.railway.internal/u', 'https://user:pw@x.example/u', 'https://localhost/u']) {
      expect(unsub({ ...m, headers: withUrl(url) })).toMatchObject({ ok: false });
    }
  });
});

describe('parseSweepMode', () => {
  it('is off unless set to shadow or live', () => {
    expect(parseSweepMode(undefined)).toBe('off');
    expect(parseSweepMode('on')).toBe('off');
    expect(parseSweepMode(' Shadow ')).toBe('shadow');
    expect(parseSweepMode('live')).toBe('live');
  });
});
