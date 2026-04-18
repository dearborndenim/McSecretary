import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import {
  createUser,
  createInvite,
  consumeInvite,
  linkTelegramChat,
  getUserByTelegramChatId,
  getUserById,
  getUserScheduleWindows,
  DEFAULT_ADMIN_CHECK_IN,
  DEFAULT_ADMIN_EOD,
  DEFAULT_MEMBER_CHECK_IN,
  DEFAULT_MEMBER_EOD,
} from '../../src/db/user-queries.js';

/**
 * End-to-end integration test for the `/start <code>` flow.
 *
 * Telegram interaction is mocked; we drive the same sequence of calls
 * the bot handler in src/index.ts makes when a user sends `/start CODE`.
 *
 * Covers:
 *  1. Admin-side invite creation
 *  2. Invitee redeems code via /start, chat_id is linked
 *  3. Role permission propagated (non-admin gets member defaults)
 *  4. Schedule windows backfilled to member defaults (6 AM + 2:30 PM CT)
 *  5. Admin flow still yields admin defaults
 *  6. Invalid / expired codes are rejected without side-effects
 */
describe('/start <code> end-to-end flow', () => {
  let db: Database.Database;
  const mockReply = vi.fn();

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    mockReply.mockReset();
  });

  // Helper that mirrors the bot logic in src/index.ts for /start handling.
  async function simulateStartCommand(text: string, chatId: string): Promise<string> {
    if (text.startsWith('/start ') && text.trim().length > 7) {
      const code = text.slice(7).trim();
      if (!code) {
        await mockReply('Usage: /start <invite_code>');
        return 'usage';
      }
      const userId = consumeInvite(db, code);
      if (!userId) {
        await mockReply('Invalid or expired invite code.');
        return 'invalid';
      }
      linkTelegramChat(db, userId, chatId);
      const linkedUser = getUserById(db, userId);
      await mockReply(`Welcome, ${linkedUser?.name ?? 'friend'}! You're linked.`);
      return 'linked';
    }
    return 'noop';
  }

  it('new member accepts invite, chat is linked, member defaults apply', async () => {
    // Admin creates user + invite
    createUser(db, { id: 'alice', name: 'Alice', email: 'alice@x.com', role: 'member' });
    const code = createInvite(db, 'alice');

    // Invitee sends /start <code>
    const result = await simulateStartCommand(`/start ${code}`, 'telegram-12345');
    expect(result).toBe('linked');

    // Chat linkage
    const byChat = getUserByTelegramChatId(db, 'telegram-12345');
    expect(byChat?.id).toBe('alice');
    expect(byChat?.role).toBe('member');

    // Schedule windows default to member (6 AM check-in, 2:30 PM EOD)
    const windows = getUserScheduleWindows(db, 'alice');
    expect(windows?.check_in_cron).toBe(DEFAULT_MEMBER_CHECK_IN);
    expect(windows?.eod_cron).toBe(DEFAULT_MEMBER_EOD);

    expect(mockReply).toHaveBeenCalledWith(expect.stringContaining("Welcome, Alice"));
  });

  it('admin role preserved through /start; admin schedule defaults apply', async () => {
    createUser(db, { id: 'rob', name: 'Robert', email: 'rob@x.com', role: 'admin' });
    const code = createInvite(db, 'rob');
    const result = await simulateStartCommand(`/start ${code}`, 'chat-rob');
    expect(result).toBe('linked');

    const user = getUserByTelegramChatId(db, 'chat-rob');
    expect(user?.role).toBe('admin');

    const windows = getUserScheduleWindows(db, 'rob');
    expect(windows?.check_in_cron).toBe(DEFAULT_ADMIN_CHECK_IN);
    expect(windows?.eod_cron).toBe(DEFAULT_ADMIN_EOD);
  });

  it('invalid code is rejected and no chat linkage is created', async () => {
    createUser(db, { id: 'bob', name: 'Bob', email: 'bob@x.com', role: 'member' });
    // Don't create a valid invite — send garbage code
    const result = await simulateStartCommand('/start deadbeef', 'chat-bob');
    expect(result).toBe('invalid');
    expect(getUserByTelegramChatId(db, 'chat-bob')).toBeUndefined();
    expect(mockReply).toHaveBeenCalledWith('Invalid or expired invite code.');
  });

  it('expired code is rejected', async () => {
    createUser(db, { id: 'eve', name: 'Eve', email: 'eve@x.com', role: 'member' });
    const code = createInvite(db, 'eve', '-1 hour');
    const result = await simulateStartCommand(`/start ${code}`, 'chat-eve');
    expect(result).toBe('invalid');
    expect(getUserByTelegramChatId(db, 'chat-eve')).toBeUndefined();
  });

  it('invite code can only be consumed once', async () => {
    createUser(db, { id: 'chuck', name: 'Chuck', email: 'chuck@x.com', role: 'member' });
    const code = createInvite(db, 'chuck');

    // First redemption succeeds
    const first = await simulateStartCommand(`/start ${code}`, 'chat-chuck-1');
    expect(first).toBe('linked');

    // Second redemption with same code fails
    const second = await simulateStartCommand(`/start ${code}`, 'chat-chuck-2');
    expect(second).toBe('invalid');

    // Original linkage intact
    const user = getUserByTelegramChatId(db, 'chat-chuck-1');
    expect(user?.id).toBe('chuck');
    expect(getUserByTelegramChatId(db, 'chat-chuck-2')).toBeUndefined();
  });
});
