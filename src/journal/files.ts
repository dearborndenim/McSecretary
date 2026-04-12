import fs from 'node:fs';
import path from 'node:path';

const JOURNAL_BASE = path.join(process.cwd(), 'data', 'journal');
const SECRETARY_DIR = path.join(JOURNAL_BASE, 'secretary');
const ROB_DIR = path.join(JOURNAL_BASE, 'rob');

export function ensureJournalDirs(): void {
  fs.mkdirSync(SECRETARY_DIR, { recursive: true });
  fs.mkdirSync(ROB_DIR, { recursive: true });
}

export function writeSecretaryReflection(date: string, content: string): void {
  ensureJournalDirs();
  fs.writeFileSync(path.join(SECRETARY_DIR, `${date}-reflection.md`), content, 'utf-8');
}

export function writeSecretaryImprovements(date: string, content: string): void {
  ensureJournalDirs();
  fs.writeFileSync(path.join(SECRETARY_DIR, `${date}-improvements.md`), content, 'utf-8');
}

export function writeSecretaryLearnings(date: string, content: string): void {
  ensureJournalDirs();
  fs.writeFileSync(path.join(SECRETARY_DIR, `${date}-learnings.md`), content, 'utf-8');
}

export function writeRobJournal(date: string, content: string): void {
  ensureJournalDirs();
  fs.writeFileSync(path.join(ROB_DIR, `${date}.md`), content, 'utf-8');
}

export function writeMasterLearnings(content: string): void {
  ensureJournalDirs();
  fs.writeFileSync(path.join(SECRETARY_DIR, 'master-learnings.md'), content, 'utf-8');
}

export function writeMasterPatterns(content: string): void {
  ensureJournalDirs();
  fs.writeFileSync(path.join(SECRETARY_DIR, 'master-patterns.md'), content, 'utf-8');
}

export function readMasterLearnings(): string {
  const filePath = path.join(SECRETARY_DIR, 'master-learnings.md');
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

export function readMasterPatterns(): string {
  const filePath = path.join(SECRETARY_DIR, 'master-patterns.md');
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

export function readSecretaryFile(date: string, type: 'reflection' | 'improvements' | 'learnings'): string {
  const filePath = path.join(SECRETARY_DIR, `${date}-${type}.md`);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

export function readRobJournal(date: string): string {
  const filePath = path.join(ROB_DIR, `${date}.md`);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

export function listSecretaryLearningsFiles(days: number = 7): string[] {
  ensureJournalDirs();
  const files = fs.readdirSync(SECRETARY_DIR)
    .filter((f) => f.endsWith('-learnings.md') && f !== 'master-learnings.md')
    .sort()
    .slice(-days);
  return files.map((f) => path.join(SECRETARY_DIR, f));
}

export function getYesterdayDate(timezone: string): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return yesterday.toLocaleDateString('en-CA', { timeZone: timezone });
}

export function getJournalHealthReport(): string {
  ensureJournalDirs();
  const lines: string[] = [];

  // Check last 7 days of reflection files
  lines.push('Reflection files (last 7 days):');
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const reflectionPath = path.join(SECRETARY_DIR, `${dateStr}-reflection.md`);
    const exists = fs.existsSync(reflectionPath);
    lines.push(`  ${dateStr}: ${exists ? 'PRESENT' : 'MISSING'}`);
  }

  // Master learnings info
  const masterLearningsPath = path.join(SECRETARY_DIR, 'master-learnings.md');
  if (fs.existsSync(masterLearningsPath)) {
    const stat = fs.statSync(masterLearningsPath);
    const content = fs.readFileSync(masterLearningsPath, 'utf-8');
    const firstLine = content.split('\n')[0] ?? '(empty)';
    lines.push(`\nmaster-learnings.md: last modified ${stat.mtime.toISOString().split('T')[0]}`);
    lines.push(`  First line: ${firstLine}`);
  } else {
    lines.push('\nmaster-learnings.md: NOT FOUND');
  }

  // Master patterns info
  const masterPatternsPath = path.join(SECRETARY_DIR, 'master-patterns.md');
  if (fs.existsSync(masterPatternsPath)) {
    const stat = fs.statSync(masterPatternsPath);
    const content = fs.readFileSync(masterPatternsPath, 'utf-8');
    const firstLine = content.split('\n')[0] ?? '(empty)';
    lines.push(`\nmaster-patterns.md: last modified ${stat.mtime.toISOString().split('T')[0]}`);
    lines.push(`  First line: ${firstLine}`);
  } else {
    lines.push('\nmaster-patterns.md: NOT FOUND');
  }

  // Next synthesis: Sunday 7 PM CT
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday
  const daysUntilSunday = dayOfWeek === 0 ? 7 : 7 - dayOfWeek;
  const nextSunday = new Date(now.getTime() + daysUntilSunday * 24 * 60 * 60 * 1000);
  const nextSynthesis = nextSunday.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  lines.push(`\nNext scheduled synthesis: ${nextSynthesis} (Sunday 7 PM CT)`);

  return lines.join('\n');
}
