import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser } from '../../src/db/user-queries.js';
import { insertDevRequest, approveDevRequest } from '../../src/db/request-queries.js';
import * as requestSync from '../../src/empire/request-sync.js';
const { formatPendingRequestsForBriefing } = requestSync;

describe('request-sync', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'admin1', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    createUser(db, { id: 'u1', name: 'Olivier', email: 'olivier@dd.com', role: 'member' });
    createUser(db, { id: 'u2', name: 'Merab', email: 'merab@dd.com', role: 'member' });
  });

  describe('formatPendingRequestsForBriefing', () => {
    it('should return undefined when no pending requests', () => {
      expect(formatPendingRequestsForBriefing(db)).toBeUndefined();
    });

    it('should format pending requests for admin briefing', () => {
      insertDevRequest(db, { user_id: 'u1', project: 'kanban-purchaser', description: 'Add reorder alerts' });
      insertDevRequest(db, { user_id: 'u2', description: 'Better dashboards' });

      const result = formatPendingRequestsForBriefing(db);
      expect(result).toBeDefined();
      expect(result).toContain('Olivier');
      expect(result).toContain('kanban-purchaser');
      expect(result).toContain('Add reorder alerts');
      expect(result).toContain('Merab');
      expect(result).toContain('Better dashboards');
    });

    it('should not include approved requests', () => {
      const id = insertDevRequest(db, { user_id: 'u1', description: 'Already approved' });
      approveDevRequest(db, id, 'admin1');

      expect(formatPendingRequestsForBriefing(db)).toBeUndefined();
    });
  });

  it('exports no GitHub/nightly-plan formatter (McSecretary is read-only)', () => {
    expect(requestSync).not.toHaveProperty('formatApprovedRequestsForPlan');
    expect(Object.keys(requestSync)).toEqual(['formatPendingRequestsForBriefing']);
  });
});
