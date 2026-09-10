import type Database from 'better-sqlite3';

export interface RfqMessageInput {
  rfq_id: string;
  vendor_email: string;
  subject: string;
  graph_message_id: string | null;
  sent_at: string;
  proposal_id: number | null;
  brand_id: string;
  /** CSV of product-dev fabric-intent ids the RFQ covered (from the proposal's evidence). */
  intents: string;
}

export interface RfqMessageRow extends RfqMessageInput {
  id: number;
  vendor_domain: string;
}

/** Lowercased domain part of an email address, or '' when it isn't one. */
export function emailDomain(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return '';
  return address.slice(at + 1).trim().toLowerCase().replace(/^[<\s]+|[>\s]+$/g, '');
}

export function insertRfqMessage(db: Database.Database, m: RfqMessageInput): number {
  const r = db.prepare(`
    INSERT INTO rfq_messages
      (rfq_id, vendor_email, vendor_domain, subject, graph_message_id, sent_at, proposal_id, brand_id, intents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.rfq_id,
    m.vendor_email,
    emailDomain(m.vendor_email),
    m.subject,
    m.graph_message_id,
    m.sent_at,
    m.proposal_id,
    m.brand_id,
    m.intents,
  );
  return Number(r.lastInsertRowid);
}

/** Most recent send for an RFQ id (the `[DD-RFQ-<id>]` subject tag). */
export function findRfqMessageByRfqId(db: Database.Database, rfqId: string): RfqMessageRow | undefined {
  if (!rfqId) return undefined;
  return db.prepare(
    'SELECT * FROM rfq_messages WHERE rfq_id = ? ORDER BY sent_at DESC, id DESC LIMIT 1',
  ).get(rfqId) as RfqMessageRow | undefined;
}

/**
 * Most recent send to a vendor domain no older than `sinceIso`. Used when the
 * vendor's reply drops the subject tag — a domain we mailed an RFQ to inside
 * the window is the reply we are waiting for.
 */
export function findRfqMessageByDomain(
  db: Database.Database,
  domain: string,
  sinceIso: string,
): RfqMessageRow | undefined {
  if (!domain) return undefined;
  return db.prepare(
    'SELECT * FROM rfq_messages WHERE vendor_domain = ? AND sent_at >= ? ORDER BY sent_at DESC, id DESC LIMIT 1',
  ).get(domain.toLowerCase(), sinceIso) as RfqMessageRow | undefined;
}

export function listRfqMessages(db: Database.Database, rfqId: string): RfqMessageRow[] {
  return db.prepare('SELECT * FROM rfq_messages WHERE rfq_id = ? ORDER BY id ASC').all(rfqId) as RfqMessageRow[];
}

/** Parse an `intents` CSV into trimmed, non-empty ids. */
export function parseIntents(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return String(csv).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
