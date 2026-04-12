import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import {
  readMasterLearnings,
  readMasterPatterns,
  writeMasterLearnings,
  writeMasterPatterns,
  listSecretaryLearningsFiles,
} from './files.js';

export async function runWeeklySynthesis(anthropic: Anthropic): Promise<void> {
  console.log('Running weekly synthesis...');

  const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const currentLearnings = readMasterLearnings();
  const currentPatterns = readMasterPatterns();

  // Read all daily learnings files from the past week
  const learningsFiles = listSecretaryLearningsFiles(7);
  if (learningsFiles.length === 0) {
    console.log('No daily learnings files found for synthesis.');
    return;
  }

  const dailyLearnings = learningsFiles
    .map((f) => {
      const content = fs.readFileSync(f, 'utf-8');
      return `--- ${f.split('/').pop()} ---\n${content}`;
    })
    .join('\n\n');

  // Synthesize master learnings
  const learningsResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    system: 'You are updating a knowledge base. Merge new information into the existing document. Deduplicate. Update anything that changed. Remove anything no longer accurate. Keep the same section structure. No emoji.',
    messages: [{
      role: 'user',
      content: `Update the master learnings file with this week's new information.

CURRENT MASTER LEARNINGS:
${currentLearnings || '(empty — this is the first synthesis)'}

THIS WEEK'S DAILY LEARNINGS:
${dailyLearnings}

Write the complete updated master learnings file. Keep the markdown structure with sections for Rob, Dearborn Denim, McMillan Manufacturing, and Key Contacts. Add a "Last updated: ${todayDate}" line at the top.`,
    }],
  });

  const newLearnings = learningsResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  writeMasterLearnings(newLearnings);
  console.log('Master learnings updated.');

  // Synthesize master patterns
  const patternsResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: 'You are updating a behavioral patterns guide. Merge new corrections and patterns. Keep what works, update what changed. No emoji.',
    messages: [{
      role: 'user',
      content: `Update the master patterns file based on this week's learnings and corrections.

CURRENT MASTER PATTERNS:
${currentPatterns || '(empty — this is the first synthesis)'}

THIS WEEK'S DAILY LEARNINGS (may contain corrections and new patterns):
${dailyLearnings}

Write the complete updated master patterns file. Keep sections for Communication, Email Handling, and Common Mistakes to Avoid. Add any new patterns discovered this week.`,
    }],
  });

  const newPatterns = patternsResponse.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  writeMasterPatterns(newPatterns);
  console.log('Master patterns updated.');
  console.log('Weekly synthesis complete.');
}
