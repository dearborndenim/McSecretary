import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing the module under test
vi.mock('../../src/config.js', () => ({
  config: {
    github: {
      token: 'test-token-123',
      org: 'test-org',
    },
  },
}));

import { listOrgRepos, readRepoFile, getFileSha, updateRepoFile } from '../../src/empire/github.js';

const originalFetch = globalThis.fetch;

function mockFetch(response: { status: number; ok: boolean; body: unknown }) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: async () => response.body,
    text: async () =>
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------- listOrgRepos ----------

describe('listOrgRepos', () => {
  it('returns parsed repo list with name, description, pushed_at', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: [
        { name: 'repo-a', description: 'First repo', pushed_at: '2026-04-09T12:00:00Z', extra_field: true },
        { name: 'repo-b', description: null, pushed_at: '2026-04-08T08:00:00Z', stargazers_count: 5 },
      ],
    });

    const repos = await listOrgRepos();

    expect(repos).toEqual([
      { name: 'repo-a', description: 'First repo', pushed_at: '2026-04-09T12:00:00Z' },
      { name: 'repo-b', description: null, pushed_at: '2026-04-08T08:00:00Z' },
    ]);

    // Verify correct URL and headers
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.github.com/orgs/test-org/repos?sort=pushed&per_page=100',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token-123',
          'User-Agent': 'McSecretary',
        }),
      }),
    );
  });

  it('returns empty array when org has no repos', async () => {
    mockFetch({ ok: true, status: 200, body: [] });
    const repos = await listOrgRepos();
    expect(repos).toEqual([]);
  });

  it('throws on API error', async () => {
    mockFetch({ ok: false, status: 403, body: 'Forbidden' });
    await expect(listOrgRepos()).rejects.toThrow('GitHub API error listing repos: 403');
  });
});

// ---------- readRepoFile ----------

describe('readRepoFile', () => {
  it('decodes base64 content from GitHub API response', async () => {
    const fileContent = '# Project Status\n\nAll good.';
    mockFetch({
      ok: true,
      status: 200,
      body: {
        content: Buffer.from(fileContent, 'utf-8').toString('base64'),
        encoding: 'base64',
        sha: 'abc123',
      },
    });

    const result = await readRepoFile('my-repo', 'PROJECT_STATUS.md');
    expect(result).toBe(fileContent);
  });

  it('builds the correct API URL with encoded file path', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { content: Buffer.from('x').toString('base64'), encoding: 'base64', sha: 'a' },
    });

    await readRepoFile('my-repo', 'docs/PLAN.md');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/repos/test-org/my-repo/contents/'),
      expect.anything(),
    );
  });

  it('throws specific error on 404', async () => {
    mockFetch({ ok: false, status: 404, body: 'Not Found' });
    await expect(readRepoFile('missing-repo', 'README.md')).rejects.toThrow(
      'File not found: README.md in test-org/missing-repo',
    );
  });

  it('throws generic error on other failures', async () => {
    mockFetch({ ok: false, status: 500, body: 'Server Error' });
    await expect(readRepoFile('repo', 'file.md')).rejects.toThrow(
      'GitHub API error reading file: 500',
    );
  });

  it('throws on unexpected encoding', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { content: 'raw text', encoding: 'utf-8', sha: 'abc' },
    });
    await expect(readRepoFile('repo', 'file.md')).rejects.toThrow('Unexpected encoding: utf-8');
  });
});

// ---------- getFileSha ----------

describe('getFileSha', () => {
  it('extracts SHA from API response', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { sha: 'deadbeef1234567890', content: 'ignored', encoding: 'base64' },
    });

    const sha = await getFileSha('my-repo', 'PROJECT_STATUS.md');
    expect(sha).toBe('deadbeef1234567890');
  });

  it('throws on API error', async () => {
    mockFetch({ ok: false, status: 401, body: 'Unauthorized' });
    await expect(getFileSha('repo', 'file.md')).rejects.toThrow(
      'GitHub API error getting file SHA: 401',
    );
  });
});

// ---------- updateRepoFile ----------

describe('updateRepoFile', () => {
  it('sends correct PUT request with base64-encoded content and SHA', async () => {
    mockFetch({ ok: true, status: 200, body: {} });

    await updateRepoFile('my-repo', 'PROJECT_STATUS.md', 'New content here', 'Update status', 'sha123');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/repos/test-org/my-repo/contents/'),
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token-123',
          'Content-Type': 'application/json',
        }),
      }),
    );

    // Verify the body contains correct fields
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.message).toBe('Update status');
    expect(body.content).toBe(Buffer.from('New content here', 'utf-8').toString('base64'));
    expect(body.sha).toBe('sha123');
  });

  it('omits SHA when creating a new file', async () => {
    mockFetch({ ok: true, status: 201, body: {} });

    await updateRepoFile('my-repo', 'NEW_FILE.md', 'Hello', 'Create file');

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body as string);
    expect(body.sha).toBeUndefined();
    expect(body.message).toBe('Create file');
  });

  it('throws on API error', async () => {
    mockFetch({ ok: false, status: 422, body: 'Unprocessable Entity' });
    await expect(
      updateRepoFile('repo', 'file.md', 'content', 'msg', 'sha'),
    ).rejects.toThrow('GitHub API error updating file: 422');
  });
});
