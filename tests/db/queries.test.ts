import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  insertProcessedEmail,
  getOrCreateSenderProfile,
  updateSenderProfile,
  insertAgentRun,
  completeAgentRun,
  insertAuditLog,
  getLastRunTimestamp,
  type ProcessedEmail,
} from '../../src/db/queries.js';

describe('queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('insertProcessedEmail', () => {
    it('inserts an email record and retrieves it', () => {
      const email: ProcessedEmail = {
        id: 'msg-123',
        account: 'outlook',
        sender: 'alice@example.com',
        sender_name: 'Alice',
        subject: 'Hello',
        received_at: '2026-04-03T05:00:00Z',
        category: 'customer_inquiry',
        urgency: 'high',
        action_needed: 'reply_required',
        action_taken: 'drafted_reply',
        confidence: 0.95,
        summary: 'Customer asking about bulk order',
        thread_id: 'thread-1',
      };

      insertProcessedEmail(db, email);

      const row = db.prepare('SELECT * FROM processed_emails WHERE id = ?').get('msg-123') as any;
      expect(row.sender).toBe('alice@example.com');
      expect(row.category).toBe('customer_inquiry');
      expect(row.confidence).toBe(0.95);
    });
  });

  describe('getOrCreateSenderProfile', () => {
    it('creates a new profile for unknown sender', () => {
      const profile = getOrCreateSenderProfile(db, 'bob@example.com', 'Bob');
      expect(profile.email).toBe('bob@example.com');
      expect(profile.name).toBe('Bob');
      expect(profile.total_emails).toBe(0);
    });

    it('returns existing profile for known sender', () => {
      getOrCreateSenderProfile(db, 'bob@example.com', 'Bob');
      const profile = getOrCreateSenderProfile(db, 'bob@example.com', 'Bob');
      expect(profile.email).toBe('bob@example.com');
    });
  });

  describe('updateSenderProfile', () => {
    it('increments email count and updates last_seen', () => {
      getOrCreateSenderProfile(db, 'bob@example.com', 'Bob');
      updateSenderProfile(db, 'bob@example.com', 'customer_inquiry', 'high');

      const row = db.prepare('SELECT * FROM sender_profiles WHERE email = ?').get('bob@example.com') as any;
      expect(row.total_emails).toBe(1);
      expect(row.default_category).toBe('customer_inquiry');
    });
  });

  describe('agent runs', () => {
    it('inserts and completes a run', () => {
      const runId = insertAgentRun(db, 'overnight');
      completeAgentRun(db, runId, { emails_processed: 42, actions_taken: 10, tokens_used: 50000, cost_estimate: 1.5 });

      const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(runId) as any;
      expect(row.emails_processed).toBe(42);
      expect(row.completed_at).not.toBeNull();
    });
  });

  describe('insertAuditLog', () => {
    it('logs an action', () => {
      insertAuditLog(db, {
        action_type: 'classify',
        target_id: 'msg-123',
        target_type: 'email',
        details: JSON.stringify({ category: 'junk' }),
        confidence: 0.99,
      });

      const row = db.prepare('SELECT * FROM audit_log WHERE target_id = ?').get('msg-123') as any;
      expect(row.action_type).toBe('classify');
      expect(row.confidence).toBe(0.99);
    });
  });
});
