import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertEvent, drainEvents, listStaleEvents, countUndrainedUrgent } from '../../src/db/event-queries.js';

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

  it('drain with no types returns nothing and marks nothing', () => {
    insertEvent(db, ev('x'), NOW);
    expect(drainEvents(db, 'a', [], NOW)).toEqual([]);
    expect(drainEvents(db, 'a', ['x'], NOW)).toHaveLength(1);
  });
});
