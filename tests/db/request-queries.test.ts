import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { createUser } from '../../src/db/user-queries.js';
import {
  insertDevRequest,
  getPendingDevRequests,
  getDevRequestsByUser,
  approveDevRequest,
  rejectDevRequest,
  getDevRequestById,
} from '../../src/db/request-queries.js';

describe('dev request queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    createUser(db, { id: 'robert', name: 'Robert', email: 'rob@dd.com', role: 'admin' });
    createUser(db, { id: 'olivier', name: 'Olivier', email: 'olivier@dd.com', role: 'member' });
  });

  it('should insert a dev request', () => {
    const id = insertDevRequest(db, {
      user_id: 'olivier',
      project: 'kanban-purchaser',
      description: 'Add a vendor report page',
    });
    expect(id).toBeGreaterThan(0);
  });

  it('should list pending dev requests', () => {
    insertDevRequest(db, { user_id: 'olivier', project: 'kanban-purchaser', description: 'Add vendor report' });
    insertDevRequest(db, { user_id: 'olivier', project: 'piece-work-scanner', description: 'Fix badge display' });
    const pending = getPendingDevRequests(db);
    expect(pending).toHaveLength(2);
  });

  it('should list dev requests by user', () => {
    insertDevRequest(db, { user_id: 'olivier', description: 'Request A' });
    insertDevRequest(db, { user_id: 'robert', description: 'Request B' });
    const olivierReqs = getDevRequestsByUser(db, 'olivier');
    expect(olivierReqs).toHaveLength(1);
    expect(olivierReqs[0]!.description).toBe('Request A');
  });

  it('should approve a dev request with refined description', () => {
    const id = insertDevRequest(db, { user_id: 'olivier', description: 'Make the thing faster' });
    approveDevRequest(db, id, 'robert', 'Optimize kanban-purchaser order batching query — add index on vendor_id + status');
    const req = getDevRequestById(db, id);
    expect(req!.status).toBe('approved');
    expect(req!.refined_description).toContain('Optimize');
    expect(req!.reviewed_by).toBe('robert');
  });

  it('should approve without refinement', () => {
    const id = insertDevRequest(db, { user_id: 'olivier', description: 'Fix the 404 on /orders' });
    approveDevRequest(db, id, 'robert');
    const req = getDevRequestById(db, id);
    expect(req!.status).toBe('approved');
    expect(req!.refined_description).toBeNull();
  });

  it('should reject a dev request', () => {
    const id = insertDevRequest(db, { user_id: 'olivier', description: 'Add AI to everything' });
    rejectDevRequest(db, id, 'robert', 'Too vague — what specifically?');
    const req = getDevRequestById(db, id);
    expect(req!.status).toBe('rejected');
    expect(req!.rejection_reason).toBe('Too vague — what specifically?');
  });

  it('should not list approved/rejected in pending', () => {
    const id1 = insertDevRequest(db, { user_id: 'olivier', description: 'A' });
    const id2 = insertDevRequest(db, { user_id: 'olivier', description: 'B' });
    insertDevRequest(db, { user_id: 'olivier', description: 'C' });
    approveDevRequest(db, id1, 'robert');
    rejectDevRequest(db, id2, 'robert', 'no');
    const pending = getPendingDevRequests(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.description).toBe('C');
  });
});
