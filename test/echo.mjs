let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({ input, args: process.argv.slice(2) }));
