import { describe, it, expect } from 'vitest';
import { parseWakeHooks, wakeRequests } from '../../src/spine/wake-hooks.js';

describe('wake hooks', () => {
  const raw = JSON.stringify([
    { types: ['grok_task_chief', 'purchasing_job'], url: 'https://hooks.example/chief', key: 'k-secret' },
    { types: ['grok_task_gina'], url: 'http://insecure.example/gina' },
  ]);

  it('keeps https hooks, refuses others without naming the url, never throws on bad JSON', () => {
    const warnings: string[] = [];
    const hooks = parseWakeHooks(raw, (m) => warnings.push(m));
    expect(hooks).toHaveLength(1);
    expect(warnings).toEqual(['SPINE_WAKE_HOOKS[1] ignored: url must be https']);
    expect(parseWakeHooks('{not json', () => {})).toEqual([]);
    expect(parseWakeHooks(undefined)).toEqual([]);
  });

  it('a queued event of a listed type yields one POST carrying only the type and id', () => {
    const hooks = parseWakeHooks(raw, () => {});
    const [r, ...rest] = wakeRequests(hooks, 'purchasing_job', 42);
    expect(rest).toEqual([]);
    expect(r!.url).toBe('https://hooks.example/chief');
    expect(r!.init.method).toBe('POST');
    expect(r!.init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer k-secret' });
    expect(JSON.parse(r!.init.body as string)).toEqual({ queued: 'purchasing_job', id: 42 });
    expect(wakeRequests(hooks, 'grok_task_chief_x', 1)).toEqual([]);
    expect(wakeRequests(hooks, 'grok_report', 1)).toEqual([]);
  });
});
