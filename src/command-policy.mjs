// One source for thread targeting, quotation and per-thread queue policy.
const queued = ['task', 'answer', 'questions'];
const targeted = [...queued, 'steer', 'fast', 'status', 'history', 'stop', 'settle', 'unsettle', 'cost', 'token', 'limit'];
const quoted = [...targeted, 'model', 'models'];
export const commandPolicy = Object.freeze(Object.fromEntries(quoted.map(kind => [kind, Object.freeze({
  targeted: targeted.includes(kind), quoted: true, queued: queued.includes(kind),
})])));
export const supportsTarget = kind => commandPolicy[kind]?.targeted === true;
export const queuesByThread = kind => commandPolicy[kind]?.queued === true;
export const quotedCommands = new Set(Object.keys(commandPolicy).filter(kind => commandPolicy[kind].quoted));
