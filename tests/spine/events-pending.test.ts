import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { insertEvent, drainEvents, countPendingByType } from '../../src/db/event-queries.js';

describe('countPendingByType', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); initializeSchema(db); });
  afterEach(() => db.close());

  it('counts undrained events per requested type, urgent separately, without draining', () => {
    const e = (t: string, u: boolean) => ({ source_hand: 'h', brand_id: 'b', event_type: t, payload: {}, urgent: u });
    insertEvent(db, e('po_received', true), '2026-09-07T00:00:00.000Z');
    insertEvent(db, e('po_received', false), '2026-09-07T00:00:00.000Z');
    insertEvent(db, e('other', true), '2026-09-07T00:00:00.000Z');
    expect(countPendingByType(db, ['po_received', 'missing'])).toEqual({ po_received: { pending: 2, urgent: 1 }, missing: { pending: 0, urgent: 0 } });
    expect(countPendingByType(db, ['po_received'])).toEqual({ po_received: { pending: 2, urgent: 1 } });
    expect(countPendingByType(db, [])).toEqual({});
    // Still drainable afterwards — counting did not claim anything.
    expect(drainEvents(db, 'a', ['po_received'], '2026-09-07T01:00:00.000Z')).toHaveLength(2);
    expect(countPendingByType(db, ['po_received'])).toEqual({ po_received: { pending: 0, urgent: 0 } });
  });
});
