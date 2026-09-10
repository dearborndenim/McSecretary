/**
 * GitHub API helpers for empire coordination — READ ONLY.
 *
 * McSecretary never writes to GitHub (Robert, 2026-09-10). This module
 * intentionally exports no mutating helper: no file update, no SHA lookup,
 * no branch/commit creation. Repository changes go to the Foreman session
 * (Claude Code), not to the secretary.
 *
 * Uses native fetch — no additional dependencies.
 */

import { config } from '../config.js';

const GITHUB_API = 'https://api.github.com';

/** The single sentence the chat agent relays when GITHUB_TOKEN is unset. */
export const GITHUB_TOKEN_MISSING_MESSAGE =
  'GitHub reads are not configured (GITHUB_TOKEN missing); ask Robert to set a read-only token on McSecretary';

/** True when a GitHub token is configured; reads are impossible without one. */
export function hasGitHubToken(): boolean {
  return Boolean(config.github.token);
}

/** Thrown when GitHub answers 404 — missing repo or missing file. */
export class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubNotFoundError';
  }
}

/** Recognizes a not-found failure from a real error or a mocked one. */
export function isGitHubNotFound(err: unknown): boolean {
  if (err instanceof GitHubNotFoundError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /not found|\b404\b/i.test(msg);
}

function getHeaders(): Record<string, string> {
  const token = config.github.token;
  if (!token) {
    throw new Error(GITHUB_TOKEN_MISSING_MESSAGE);
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'McSecretary',
  };
}

/**
 * List all repos in the configured GitHub org.
 */
export async function listOrgRepos(): Promise<
  { name: string; description: string | null; pushed_at: string }[]
> {
  const org = config.github.org;
  const res = await fetch(`${GITHUB_API}/orgs/${org}/repos?sort=pushed&per_page=100`, {
    headers: getHeaders(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error listing repos: ${res.status} ${text}`);
  }

  const repos = (await res.json()) as {
    name: string;
    description: string | null;
    pushed_at: string;
  }[];

  return repos.map((r) => ({
    name: r.name,
    description: r.description,
    pushed_at: r.pushed_at,
  }));
}

/**
 * Read a file from a GitHub repo (default branch).
 * Returns the decoded UTF-8 content.
 */
export async function readRepoFile(
  repoName: string,
  filePath: string,
): Promise<string> {
  const org = config.github.org;
  const url = `${GITHUB_API}/repos/${org}/${repoName}/contents/${encodeURIComponent(filePath)}`;
  const res = await fetch(url, { headers: getHeaders() });

  if (!res.ok) {
    if (res.status === 404) {
      throw new GitHubNotFoundError(`File not found: ${filePath} in ${org}/${repoName}`);
    }
    const text = await res.text();
    throw new Error(`GitHub API error reading file: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { content: string; encoding: string; sha: string };

  if (data.encoding !== 'base64') {
    throw new Error(`Unexpected encoding: ${data.encoding}`);
  }

  return Buffer.from(data.content, 'base64').toString('utf-8');
}
