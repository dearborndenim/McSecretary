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
  /** The inbound vendor-reply message id the acknowledgement was sent for, if any. */
  ack_message_id: string | null;
  /** When the acknowledgement for `ack_message_id` was sent. Null until then. */
  acknowledged_at: string | null;
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

/**
 * Has an acknowledgement already gone out for this inbound vendor-reply message?
 * Keyed by the reply's own Graph message id, not the RFQ — a re-triage of the
 * same inbound message (restart, retry, reprocessing) must never send twice,
 * regardless of which outbound row `matchRfqReply` resolves it to.
 */
export function isRfqReplyAcknowledged(db: Database.Database, inboundMessageId: string): boolean {
  if (!inboundMessageId) return false;
  const row = db.prepare(
    'SELECT 1 FROM rfq_messages WHERE ack_message_id = ? AND acknowledged_at IS NOT NULL LIMIT 1',
  ).get(inboundMessageId);
  return row !== undefined;
}

/** Record that the outbound row `rowId` (the RFQ send matchRfqReply resolved) was acknowledged for inbound message `inboundMessageId`. */
export function markRfqReplyAcknowledged(
  db: Database.Database,
  rowId: number,
  inboundMessageId: string,
  ackedAt: string,
): void {
  db.prepare('UPDATE rfq_messages SET ack_message_id = ?, acknowledged_at = ? WHERE id = ?')
    .run(inboundMessageId, ackedAt, rowId);
}

/**
 * Has this *inbound* vendor-reply message already been run through the RFQ
 * intake? Keyed on the reply's own Graph message id so the 30-minute Email
 * Scan job and the 5 AM triage (or an on-demand "scan rfq") never re-file
 * quotes or re-card an unparsed reply for the same message.
 */
export function isRfqReplyProcessed(db: Database.Database, messageId: string): boolean {
  if (!messageId) return false;
  const row = db.prepare('SELECT 1 FROM rfq_replies WHERE message_id = ? LIMIT 1').get(messageId);
  return row !== undefined;
}

/** Record that inbound message `messageId` was run through the RFQ intake for `rfqId`. */
export function markRfqReplyProcessed(
  db: Database.Database,
  messageId: string,
  rfqId: string,
  processedAt: string,
): void {
  db.prepare(
    'INSERT OR IGNORE INTO rfq_replies (message_id, rfq_id, processed_at) VALUES (?, ?, ?)',
  ).run(messageId, rfqId, processedAt);
}

/** Parse an `intents` CSV into trimmed, non-empty ids. */
export function parseIntents(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return String(csv).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
