import type Database from 'better-sqlite3';

/** Maturity lags from spec §4.9. Learners read only rows whose matured_at <= now. */
export const MATURITY_SEED: ReadonlyArray<{ lane: string; metric: string; lag_days: number }> = [
  { lane: 'marketing', metric: 'roas', lag_days: 7 },
  { lane: 'marketing', metric: 'new_customer_return_rate', lag_days: 90 },
  { lane: 'ops', metric: 'on_time_delivery', lag_days: 0 },
  { lane: 'ops', metric: 'receipt_vs_promised_days', lag_days: 0 },
  { lane: 'product', metric: 'sell_through', lag_days: 60 },
  { lane: 'product', metric: 'return_rate', lag_days: 90 },
  { lane: 'product', metric: 'margin', lag_days: 90 },
  { lane: 'product', metric: 'repeat_purchase_rate', lag_days: 180 },
];

export function initializeSpineSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_payload TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '{}',
      cost_usd REAL NOT NULL DEFAULT 0,
      reversible INTEGER NOT NULL DEFAULT 0,
      level_required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT,
      edits TEXT,
      edit_requested_at TEXT,
      execution_result TEXT,
      telegram_chat_id TEXT,
      telegram_message_id INTEGER,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_proposals_dedupe ON proposals(agent, brand_id, action_type, payload_hash);

    CREATE TABLE IF NOT EXISTS spine_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_hand TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      urgent INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      drained_by TEXT,
      drained_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_spine_events_drain ON spine_events(drained_at, event_type);

    CREATE TABLE IF NOT EXISTS trust_ledger (
      agent TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      approved_as_proposed INTEGER NOT NULL DEFAULT 0,
      approved_with_edit INTEGER NOT NULL DEFAULT 0,
      rejected INTEGER NOT NULL DEFAULT 0,
      last_change_at TEXT,
      last_change_by TEXT,
      PRIMARY KEY (agent, brand_id, action_type)
    );

    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      attributes TEXT NOT NULL,
      prediction TEXT,
      metrics TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      matured_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_lane_matured ON outcomes(lane, matured_at);

    CREATE TABLE IF NOT EXISTS outcome_maturity (
      lane TEXT NOT NULL,
      metric TEXT NOT NULL,
      lag_days INTEGER NOT NULL,
      PRIMARY KEY (lane, metric)
    );

    -- agent_run_index: business-agent runs (spine); unrelated to the older agent_runs table used by the email triage loop.
    CREATE TABLE IF NOT EXISTS agent_run_index (
      run_id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      brand_id TEXT NOT NULL,
      skill_commit TEXT NOT NULL,
      model TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      outcome TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_agent_run_index_outcome ON agent_run_index(outcome, started_at);

    -- rfq_messages: every email the built-in email hand sends, so a vendor's
    -- reply can be correlated back to the RFQ (by the [DD-RFQ-<id>] subject tag)
    -- or, when the vendor strips the tag, by their sending domain. intents is
    -- the CSV of product-dev fabric-intent ids the RFQ covered, copied from the
    -- proposal's evidence at send time -- the reply's quotes are filed against
    -- them.
    CREATE TABLE IF NOT EXISTS rfq_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_id TEXT NOT NULL DEFAULT '',
      vendor_email TEXT NOT NULL,
      vendor_domain TEXT NOT NULL,
      subject TEXT NOT NULL,
      graph_message_id TEXT,
      sent_at TEXT NOT NULL,
      proposal_id INTEGER,
      brand_id TEXT NOT NULL DEFAULT '',
      intents TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_rfq_messages_rfq ON rfq_messages(rfq_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_rfq_messages_domain ON rfq_messages(vendor_domain, sent_at);

    -- rfq_replies: one row per *inbound* vendor-reply message that has already
    -- been run through the RFQ intake (quotes filed / notes card raised).
    -- Keyed on the inbound Graph message id so the 30-minute Email Scan job
    -- and the 5 AM triage (or a Telegram "scan rfq") never double-file the
    -- same reply, regardless of which one sees it first.
    CREATE TABLE IF NOT EXISTS rfq_replies (
      message_id TEXT PRIMARY KEY,
      rfq_id TEXT NOT NULL DEFAULT '',
      processed_at TEXT NOT NULL
    );
  `);

  // Additive migration: proposals.run_id (Stage 0B provenance link). PRAGMA-gated like user-schema.ts.
  const cols = (db.prepare('PRAGMA table_info(proposals)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('run_id')) db.exec('ALTER TABLE proposals ADD COLUMN run_id TEXT');

  // Additive migration: rfq_messages.ack_message_id / acknowledged_at (RFQ reply
  // acknowledgement, spec change 2). ack_message_id holds the *inbound* vendor
  // message id that triggered the ack, keyed on the outbound row matchRfqReply
  // resolved -- a re-triage of the same inbound message id never sends twice.
  const rfqCols = (db.prepare('PRAGMA table_info(rfq_messages)').all() as { name: string }[]).map((c) => c.name);
  if (!rfqCols.includes('ack_message_id')) db.exec('ALTER TABLE rfq_messages ADD COLUMN ack_message_id TEXT');
  if (!rfqCols.includes('acknowledged_at')) db.exec('ALTER TABLE rfq_messages ADD COLUMN acknowledged_at TEXT');

  // Additive migration: rfq_messages.conversation_id — Graph's conversationId
  // for the outbound RFQ send, when Graph returns one. The RFQ reply matcher's
  // domain fallback requires the inbound reply to be in this same conversation
  // (or carry the [DD-RFQ-…] subject tag) before it will treat a same-domain
  // sender as a vendor reply — see src/email/rfq-intake.ts matchRfqReply.
  if (!rfqCols.includes('conversation_id')) db.exec('ALTER TABLE rfq_messages ADD COLUMN conversation_id TEXT');

  const seed = db.prepare(
    'INSERT OR IGNORE INTO outcome_maturity (lane, metric, lag_days) VALUES (?, ?, ?)',
  );
  for (const m of MATURITY_SEED) seed.run(m.lane, m.metric, m.lag_days);
}
