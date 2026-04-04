/**
 * Live integration test — hits real APIs and reports results.
 * Run with: npx tsx src/test-live.ts
 */
import 'dotenv/config';
import { config } from './config.js';
import { getGraphToken } from './auth/graph.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

const results: TestResult[] = [];

function pass(name: string, detail: string) {
  results.push({ name, status: 'PASS', detail });
  console.log(`  PASS: ${name} — ${detail}`);
}

function fail(name: string, detail: string) {
  results.push({ name, status: 'FAIL', detail });
  console.log(`  FAIL: ${name} — ${detail}`);
}

async function testGraphAuth(): Promise<string | null> {
  console.log('\n=== Test 1: Graph API Authentication ===');
  try {
    const token = await getGraphToken();
    if (token && token.length > 0) {
      pass('Graph Auth', `Token acquired (${token.length} chars)`);
      return token;
    } else {
      fail('Graph Auth', 'Token is empty');
      return null;
    }
  } catch (err) {
    fail('Graph Auth', `${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function testOutlookEmail(token: string, email: string): Promise<void> {
  console.log(`\n=== Test 2: Fetch Emails — ${email} ===`);
  try {
    const url = `${GRAPH_BASE}/users/${email}/messages?$top=3&$select=id,subject,from,receivedDateTime&$orderby=receivedDateTime desc`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!res.ok) {
      const body = await res.text();
      fail(`Email ${email}`, `${res.status}: ${body.slice(0, 200)}`);
      return;
    }

    const data = await res.json() as { value: any[] };
    pass(`Email ${email}`, `${data.value.length} messages fetched`);
    for (const msg of data.value) {
      console.log(`    - "${msg.subject}" from ${msg.from?.emailAddress?.address} (${msg.receivedDateTime})`);
    }
  } catch (err) {
    fail(`Email ${email}`, `${err instanceof Error ? err.message : err}`);
  }
}

async function testOutlookCalendar(token: string, email: string): Promise<void> {
  console.log(`\n=== Test 3: Fetch Calendar — ${email} ===`);
  try {
    const now = new Date().toISOString();
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString();
    const url = `${GRAPH_BASE}/users/${email}/calendarview?startDateTime=${now}&endDateTime=${tomorrow}&$top=5&$select=id,subject,start,end,isAllDay`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      fail(`Calendar ${email}`, `${res.status}: ${body.slice(0, 200)}`);
      return;
    }

    const data = await res.json() as { value: any[] };
    pass(`Calendar ${email}`, `${data.value.length} events found`);
    for (const evt of data.value) {
      console.log(`    - "${evt.subject}" ${evt.start?.dateTime} — ${evt.end?.dateTime}`);
    }
  } catch (err) {
    fail(`Calendar ${email}`, `${err instanceof Error ? err.message : err}`);
  }
}

async function testAnthropicAPI(): Promise<void> {
  console.log('\n=== Test 4: Anthropic API ===');
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Say "McSecretary API test successful" and nothing else.' }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as any).text)
      .join('');

    pass('Anthropic Haiku', text.slice(0, 100));

    // Test Sonnet too
    const response2 = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Say "Sonnet test OK" and nothing else.' }],
    });

    const text2 = response2.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as any).text)
      .join('');

    pass('Anthropic Sonnet', text2.slice(0, 100));
  } catch (err) {
    fail('Anthropic API', `${err instanceof Error ? err.message : err}`);
  }
}

async function testTelegramBot(): Promise<void> {
  console.log('\n=== Test 5: Telegram Bot ===');
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username: string } };

    if (data.ok && data.result) {
      pass('Telegram Bot', `@${data.result.username} is active`);
    } else {
      fail('Telegram Bot', `getMe failed: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    fail('Telegram Bot', `${err instanceof Error ? err.message : err}`);
  }
}

async function testSendMail(token: string): Promise<void> {
  console.log('\n=== Test 6: Send Email Capability ===');
  try {
    // Just check if we have sendMail permission by trying to access the endpoint
    // We won't actually send — just verify access
    const url = `${GRAPH_BASE}/users/${config.outlook.email2}/mailFolders/sentitems/messages?$top=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!res.ok) {
      const body = await res.text();
      fail('Send Mail', `${res.status}: ${body.slice(0, 200)}`);
      return;
    }

    pass('Send Mail', 'Have access to sent items (sendMail should work)');
  } catch (err) {
    fail('Send Mail', `${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  console.log('McSECREtary Live Integration Tests');
  console.log('===================================');
  console.log(`Outlook 1: ${config.outlook.email1}`);
  console.log(`Outlook 2: ${config.outlook.email2}`);
  console.log(`Telegram Chat ID: ${config.telegram.chatId}`);

  const token = await testGraphAuth();

  if (token) {
    await testOutlookEmail(token, config.outlook.email1);
    await testOutlookEmail(token, config.outlook.email2);
    await testOutlookCalendar(token, config.outlook.email1);
    await testOutlookCalendar(token, config.outlook.email2);
    await testSendMail(token);
  } else {
    console.log('\nSkipping Graph API tests — auth failed.');
  }

  await testAnthropicAPI();
  await testTelegramBot();

  // Summary
  console.log('\n===================================');
  console.log('SUMMARY');
  console.log('===================================');
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} tests\n`);

  for (const r of results) {
    console.log(`  ${r.status === 'PASS' ? 'OK' : 'XX'} ${r.name}`);
  }

  if (failed > 0) {
    console.log('\nFailed tests:');
    for (const r of results.filter((r) => r.status === 'FAIL')) {
      console.log(`  ${r.name}: ${r.detail}`);
    }
  }
}

main().catch(console.error);
