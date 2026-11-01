import { createHash } from 'node:crypto';
if (process.argv.includes('--wait')) throw new Error('Concurrency regression: thread creation must not wait for the task.');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const id = createHash('sha256').update(input).digest('hex').slice(0, 12);
// Matches the installed T3 CLI's non-waiting ThreadLaunchResult schema.
process.stdout.write(JSON.stringify({ threadId: `thread-${id}`, projectId: 'p', runId: `run-${id}` }));
