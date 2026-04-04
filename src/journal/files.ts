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
