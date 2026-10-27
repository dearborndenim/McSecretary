import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertEvent, drainEvents, listStaleEvents, countUndrainedUrgent, countPendingByType, deliveryCutoverId } from '../../src/db/event-queries.js';

const NOW = '2026-09-07T12:00:00.000Z';
const ev = (event_type: string, urgent = false) => ({ source_hand: 'purchase-order-receiver', brand_id: 'dearborn-denim', event_type, payload: { po: 1 }, urgent });

describe('event queue', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('drains only the requested types, marks them, and does not re-drain', () => {
    insertEvent(db, ev('po_received', true), NOW);
    insertEvent(db, ev('reorder_suggested'), NOW);
    const got = drainEvents(db, 'production-planner', ['po_received'], NOW);
    expect(got.map((e) => e.event_type)).toEqual(['po_received']);
    expect(got[0]!.urgent).toBe(1);
    expect(JSON.parse(got[0]!.payload).po).toBe(1);
    expect(drainEvents(db, 'production-planner', ['po_received'], NOW)).toEqual([]);
    expect(drainEvents(db, 'purchasing', ['reorder_suggested'], NOW)).toHaveLength(1);
  });

  it('lists undrained events older than N days', () => {
    insertEvent(db, ev('old'), '2026-08-20T00:00:00.000Z');
    insertEvent(db, ev('fresh'), NOW);
    expect(listStaleEvents(db, 7, NOW).map((e) => e.event_type)).toEqual(['old']);
  });

  it('counts undrained urgent events per brand', () => {
    insertEvent(db, ev('a', true), NOW);
    insertEvent(db, ev('b', false), NOW);
    expect(countUndrainedUrgent(db, 'dearborn-denim')).toBe(1);
  });

  it('drains one brand at a time when given a brand id, leaving the other brand undrained', () => {
    const k = { ...ev('design_request', true), brand_id: 'knits' };
    insertEvent(db, ev('design_request', true), NOW);
    insertEvent(db, k, NOW);
    const got = drainEvents(db, 'designer', ['design_request'], NOW, 'knits');
    expect(got.map((e) => e.brand_id)).toEqual(['knits']);
    expect(countUndrainedUrgent(db, 'dearborn-denim')).toBe(1);
    expect(countUndrainedUrgent(db, 'knits')).toBe(0);
    expect(drainEvents(db, 'designer', ['design_request'], NOW, 'knits')).toEqual([]);
    expect(drainEvents(db, 'designer', ['design_request'], NOW).map((e) => e.brand_id)).toEqual(['dearborn-denim']);
  });

  it('drain with no types returns nothing and marks nothing', () => {
    insertEvent(db, ev('x'), NOW);
    expect(drainEvents(db, 'a', [], NOW)).toEqual([]);
    expect(drainEvents(db, 'a', ['x'], NOW)).toHaveLength(1);
  });

  // Regression (SR-20261027-001): design-artist drained every design_sheet_executed
  // first, so sourcing and costing never got one.
  it('delivers a design_sheet_executed to each of its three consumers exactly once', () => {
    const id = insertEvent(db, ev('design_sheet_executed', true), NOW);
    for (const agent of ['design-artist', 'sourcing', 'costing']) {
      expect(countPendingByType(db, ['design_sheet_executed'], undefined, agent).design_sheet_executed).toEqual({ pending: 1, urgent: 1 });
      expect(drainEvents(db, agent, ['design_sheet_executed'], NOW, 'dearborn-denim').map((e) => e.id)).toEqual([id]);
    }
    for (const agent of ['design-artist', 'sourcing', 'costing']) {
      expect(drainEvents(db, agent, ['design_sheet_executed'], NOW)).toEqual([]);
      expect(countPendingByType(db, ['design_sheet_executed'], undefined, agent).design_sheet_executed!.pending).toBe(0);
    }
    const row = db.prepare('SELECT drained_by FROM spine_events WHERE id = ?').get(id) as { drained_by: string };
    expect(row.drained_by).toBe('design-artist');
    expect(countPendingByType(db, ['design_sheet_executed']).design_sheet_executed!.pending).toBe(0);
  });

  it('keeps an in-process consume (drained_at set, no delivery row) consumed for every agent', () => {
    const id = insertEvent(db, ev('grok_digest'), NOW);
    db.prepare("UPDATE spine_events SET drained_by = 'mcsecretary', drained_at = ? WHERE id = ?").run(NOW, id);
    expect(drainEvents(db, 'grok-bots', ['grok_digest'], NOW)).toEqual([]);
    expect(countPendingByType(db, ['grok_digest'], undefined, 'grok-bots').grok_digest!.pending).toBe(0);
  });
});

describe('per-consumer delivery cutover (migration)', () => {
  const OLD_SCHEMA = `CREATE TABLE spine_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_hand TEXT NOT NULL, brand_id TEXT NOT NULL,
    event_type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', urgent INTEGER NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL DEFAULT (datetime('now')), drained_by TEXT, drained_at TEXT, posted_by TEXT
  )`;
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(OLD_SCHEMA);
    const put = db.prepare("INSERT INTO spine_events (source_hand, brand_id, event_type, payload, urgent, received_at, drained_by, drained_at) VALUES ('design-module', 'dearborn-denim', 'design_sheet_executed', '{}', 1, ?, ?, ?)");
    put.run(NOW, 'design-artist', NOW); // like events 1030-1036: drained by design-artist before the fix
    put.run(NOW, null, null); // pre-cutover, not drained yet
  });
  afterEach(() => db.close());

  it('records the cutover at the newest existing id, leaves rows untouched, and keeps it on re-run', () => {
    const before = db.prepare('SELECT * FROM spine_events ORDER BY id').all();
    initializeSchema(db);
    expect(deliveryCutoverId(db)).toBe(2);
    expect(db.prepare('SELECT * FROM spine_events ORDER BY id').all()).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) AS n FROM spine_event_deliveries').get() as { n: number }).n).toBe(0);
    insertEvent(db, ev('design_sheet_executed'), NOW);
    initializeSchema(db);
    expect(deliveryCutoverId(db)).toBe(2);
  });

  it('never re-delivers a pre-cutover event; delivers new ones to every consumer', () => {
    initializeSchema(db);
    const fresh = insertEvent(db, ev('design_sheet_executed'), NOW);
    // The undrained pre-cutover event keeps the one-drain rule: sourcing takes it, costing does not.
    expect(drainEvents(db, 'sourcing', ['design_sheet_executed'], NOW).map((e) => e.id)).toEqual([2, fresh]);
    expect(countPendingByType(db, ['design_sheet_executed'], undefined, 'costing').design_sheet_executed!.pending).toBe(1);
    expect(drainEvents(db, 'costing', ['design_sheet_executed'], NOW).map((e) => e.id)).toEqual([fresh]);
    expect(drainEvents(db, 'design-artist', ['design_sheet_executed'], NOW).map((e) => e.id)).toEqual([fresh]);
  });
});
