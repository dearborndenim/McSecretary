import type Database from 'better-sqlite3';

/**
 * Chief digest (spec docs/superpowers/specs/2026-11-10-chief-digest-design.md in
 * the claude_code repo). One `chief_digests` row per digest posted to Chief; one
 * `chief_digest_items` row per numbered draft in it, holding what the decision
 * path needs to act (the proposal id, or the Outlook mailbox + message id +
 * changeKey seen at digest time) and, once Chief relays it, the decision.
 */
export function initializeChiefDigestSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chief_digests (
      digest_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      since TEXT NOT NULL,
      event_id INTEGER,
      -- sha256 of the approve code sent to Robert on Telegram (null: no code required)
      code_hash TEXT,
      code_failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_chief_digests_created ON chief_digests(created_at);

    CREATE TABLE IF NOT EXISTS chief_digest_items (
      digest_id TEXT NOT NULL REFERENCES chief_digests(digest_id),
      n INTEGER NOT NULL,
      item_key TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('proposal', 'outlook_draft')),
      proposal_id INTEGER,
      mailbox TEXT,
      message_id TEXT,
      change_key TEXT,
      last_modified TEXT,
      subject TEXT,
      decision TEXT CHECK (decision IN ('approve', 'reject', 'edit')),
      edit_text TEXT,
      robert_quote TEXT,
      decided_at TEXT,
      received_at TEXT,
      outcome TEXT,
      outcome_reason TEXT,
      send_attempted_at TEXT,
      PRIMARY KEY (digest_id, n)
    );
    CREATE INDEX IF NOT EXISTS idx_chief_digest_items_msg ON chief_digest_items(mailbox, message_id);
    CREATE INDEX IF NOT EXISTS idx_chief_digest_items_sends ON chief_digest_items(send_attempted_at);
  `);
}

export interface ChiefDigestRow {
  digest_id: string;
  created_at: string;
  since: string;
  event_id: number | null;
  code_hash: string | null;
  code_failures: number;
}

export interface ChiefDigestItemInput {
  n: number;
  item_key: string;
  source: 'proposal' | 'outlook_draft';
  proposal_id: number | null;
  mailbox: string | null;
  message_id: string | null;
  change_key: string | null;
  last_modified: string | null;
  subject: string;
}

export interface ChiefDigestItemRow extends ChiefDigestItemInput {
  digest_id: string;
  decision: 'approve' | 'reject' | 'edit' | null;
  edit_text: string | null;
  robert_quote: string | null;
  decided_at: string | null;
  received_at: string | null;
  outcome: string | null;
  outcome_reason: string | null;
  send_attempted_at: string | null;
}

/** The newest digest: the only one a decision may name. */
export function latestDigest(db: Database.Database): ChiefDigestRow | null {
  return (db.prepare('SELECT * FROM chief_digests ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as ChiefDigestRow | undefined) ?? null;
}

export function insertDigest(
  db: Database.Database,
  d: { digest_id: string; created_at: string; since: string; code_hash: string | null },
  items: ChiefDigestItemInput[],
): void {
  db.transaction(() => {
    db.prepare('INSERT INTO chief_digests (digest_id, created_at, since, code_hash) VALUES (?, ?, ?, ?)')
      .run(d.digest_id, d.created_at, d.since, d.code_hash);
    const ins = db.prepare(`
      INSERT INTO chief_digest_items (digest_id, n, item_key, source, proposal_id, mailbox, message_id, change_key, last_modified, subject)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const i of items) {
      ins.run(d.digest_id, i.n, i.item_key, i.source, i.proposal_id, i.mailbox, i.message_id, i.change_key, i.last_modified, i.subject);
    }
  })();
}

export function setDigestEventId(db: Database.Database, digestId: string, eventId: number): void {
  db.prepare('UPDATE chief_digests SET event_id = ? WHERE digest_id = ?').run(eventId, digestId);
}

export function getDigestItem(db: Database.Database, digestId: string, n: number): ChiefDigestItemRow | null {
  return (db.prepare('SELECT * FROM chief_digest_items WHERE digest_id = ? AND n = ?').get(digestId, n) as ChiefDigestItemRow | undefined) ?? null;
}

/** The claim: true for exactly one caller per item; a decided item is never re-decided. */
export function claimDigestItem(
  db: Database.Database,
  digestId: string,
  n: number,
  d: { decision: 'approve' | 'reject' | 'edit'; edit_text: string | null; robert_quote: string; decided_at: string; received_at: string },
): boolean {
  const r = db.prepare(`
    UPDATE chief_digest_items SET decision = ?, edit_text = ?, robert_quote = ?, decided_at = ?, received_at = ?
    WHERE digest_id = ? AND n = ? AND decision IS NULL
  `).run(d.decision, d.edit_text, d.robert_quote, d.decided_at, d.received_at, digestId, n);
  return r.changes === 1;
}

export function setItemOutcome(db: Database.Database, digestId: string, n: number, outcome: string, reason: string | null): void {
  db.prepare('UPDATE chief_digest_items SET outcome = ?, outcome_reason = ? WHERE digest_id = ? AND n = ?')
    .run(outcome, reason, digestId, n);
}

/** When an Outlook draft was last rejected through a digest, or null. */
export function lastRejectedAt(db: Database.Database, mailbox: string, messageId: string): string | null {
  const r = db.prepare(`
    SELECT MAX(decided_at) AS at FROM chief_digest_items
    WHERE mailbox = ? AND message_id = ? AND decision = 'reject'
  `).get(mailbox, messageId) as { at: string | null } | undefined;
  return r?.at ?? null;
}

/** One more wrong approve code on this digest; returns the new count. */
export function recordCodeFailure(db: Database.Database, digestId: string): number {
  db.prepare('UPDATE chief_digests SET code_failures = code_failures + 1 WHERE digest_id = ?').run(digestId);
  return (db.prepare('SELECT code_failures FROM chief_digests WHERE digest_id = ?').get(digestId) as { code_failures: number }).code_failures;
}

/** Mark the moment a Graph /send is attempted for an item (counts toward the daily cap whatever the outcome). */
export function markSendAttempt(db: Database.Database, digestId: string, n: number, atIso: string): void {
  db.prepare('UPDATE chief_digest_items SET send_attempted_at = ? WHERE digest_id = ? AND n = ?').run(atIso, digestId, n);
}

/** Outlook /send attempts since `sinceIso` (the caller narrows to the Chicago day). */
export function sendAttemptsSince(db: Database.Database, sinceIso: string): string[] {
  return (db.prepare(`
    SELECT send_attempted_at AS at FROM chief_digest_items
    WHERE source = 'outlook_draft' AND send_attempted_at IS NOT NULL AND send_attempted_at >= ?
  `).all(sinceIso) as { at: string }[]).map((r) => r.at);
}
