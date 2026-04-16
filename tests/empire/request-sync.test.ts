import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser } from '../../src/db/user-queries.js';
import { insertDevRequest, approveDevRequest } from '../../src/db/request-queries.js';
import { formatApprovedRequestsForPlan, formatPendingRequestsForBriefing } from '../../src/empire/request-sync.js';

describe('request-sync', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'admin1', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    createUser(db, { id: 'u1', name: 'Olivier', email: 'olivier@dd.com', role: 'member' });
    createUser(db, { id: 'u2', name: 'Merab', email: 'merab@dd.com', role: 'member' });
  });

  describe('formatApprovedRequestsForPlan', () => {
    it('should return empty string when no approved requests', () => {
      expect(formatApprovedRequestsForPlan(db)).toBe('');
    });

    it('should format approved requests for the nightly plan', () => {
      const id1 = insertDevRequest(db, { user_id: 'u1', project: 'kanban-purchaser', description: 'Add reorder alerts' });
      const id2 = insertDevRequest(db, { user_id: 'u2', description: 'Dashboard for production tracking' });
      approveDevRequest(db, id1, 'admin1', 'Add reorder threshold alerts to kanban-purchaser');
      approveDevRequest(db, id2, 'admin1');

      const result = formatApprovedRequestsForPlan(db);
      expect(result).toContain('Team Request #');
      expect(result).toContain('Olivier');
      expect(result).toContain('kanban-purchaser');
      expect(result).toContain('reorder');
      expect(result).toContain('Merab');
      expect(result).toContain('Dashboard for production tracking');
    });

    it('should use refined_description when available', () => {
      const id = insertDevRequest(db, { user_id: 'u1', description: 'fix the thing' });
      approveDevRequest(db, id, 'admin1', 'Fix the pagination bug in the inventory list');

      const result = formatApprovedRequestsForPlan(db);
      expect(result).toContain('Fix the pagination bug in the inventory list');
      expect(result).not.toContain('fix the thing');
    });

    it('should not include pending or rejected requests', () => {
      insertDevRequest(db, { user_id: 'u1', description: 'pending request' });
      const rejId = insertDevRequest(db, { user_id: 'u2', description: 'rejected request' });
      db.prepare("UPDATE dev_requests SET status = 'rejected' WHERE id = ?").run(rejId);

      expect(formatApprovedRequestsForPlan(db)).toBe('');
    });
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
});
