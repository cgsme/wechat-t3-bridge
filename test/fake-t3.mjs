let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({
  threadId: 'created-thread', runId: 'created-run', status: 'failed', reply: null,
  args: process.argv.slice(2), input,
}));
process.exitCode = 1;
