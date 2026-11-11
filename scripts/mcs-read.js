#!/usr/bin/env node
// Read-only view of McSecretary's approval cards, Telegram chat log and audit log.
//   node scripts/mcs-read.js proposals|conversations|audit [--since ISO] [--status x] [--id n] [--user-id x] [--limit n]
// Key: the grok-inbox line of ~/.foreman/agent-keys (mode 600, same file bin/grok-inbox.js reads).
// Base URL: MCSECRETARY_URL from the environment, else ~/.foreman/env. The key is never printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENT = 'grok-inbox';
const VIEWS = ['proposals', 'conversations', 'audit'];
const FLAGS = { '--since': 'since', '--status': 'status', '--id': 'id', '--user-id': 'user_id', '--limit': 'limit' };
const home = process.env.FOREMAN_HOME || os.homedir();

function die(msg) { process.stderr.write(`mcs-read: ${msg}\n`); process.exit(2); }

function readKey() {
  const file = path.join(home, '.foreman', 'agent-keys');
  let text;
  try {
    if (fs.statSync(file).mode & 0o077) die(`${file} must be mode 600`);
    text = fs.readFileSync(file, 'utf8');
  } catch { die(`cannot read ${file}`); }
  for (const line of text.split('\n')) {
    const t = line.trim();
    const eq = t.indexOf('=');
    if (!t.startsWith('#') && eq > 0 && t.slice(0, eq).trim() === AGENT) return t.slice(eq + 1).trim();
  }
  return die(`no ${AGENT} line in ${file}`);
}

function readBaseUrl() {
  if (process.env.MCSECRETARY_URL) return process.env.MCSECRETARY_URL;
  try {
    for (const line of fs.readFileSync(path.join(home, '.foreman', 'env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?MCSECRETARY_URL\s*=\s*(.*)$/);
      if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* fall through */ }
  return die('MCSECRETARY_URL is not set (environment or ~/.foreman/env)');
}

const [view, ...rest] = process.argv.slice(2);
if (!VIEWS.includes(view)) die(`usage: mcs-read ${VIEWS.join('|')} [--since ISO] [--status x] [--id n] [--user-id x] [--limit n]`);
const qs = new URLSearchParams();
for (let i = 0; i < rest.length; i += 2) {
  const name = FLAGS[rest[i]];
  if (!name || rest[i + 1] === undefined) die(`bad argument ${rest[i]}`);
  qs.set(name, rest[i + 1]);
}

const url = `${readBaseUrl().replace(/\/+$/, '')}/spine/admin/${view}${qs.size ? `?${qs}` : ''}`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${readKey()}`, Accept: 'application/json' } });
const text = await res.text();
let out;
try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { out = text; }
process.stdout.write(`${out}\n`);
if (!res.ok) { process.stderr.write(`mcs-read: HTTP ${res.status}\n`); process.exit(1); }
