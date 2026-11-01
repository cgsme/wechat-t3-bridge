import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function listSkills(config = {}) {
  const roots = [path.join(os.homedir(), '.agents', 'skills'), path.join(os.homedir(), '.codex', 'skills'),
    ...(config.cwd ? [path.join(config.cwd, '.agents', 'skills')] : [])];
  const found = new Map();
  function walk(root, depth = 0) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const file = path.join(root, 'SKILL.md');
    if (entries.some(entry => entry.name === 'SKILL.md' && entry.isFile())) {
      const source = fs.readFileSync(file, 'utf8');
      const header = source.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const field = name => header?.[1].match(new RegExp('^' + name + ':\\s*(.+)$', 'm'))?.[1].trim().replace(/^(["\x27])([\s\S]*)\1$/, '$2');
      const name = field('name') || path.basename(root);
      found.set(name, { name, description: field('description') || '', file });
      return;
    }
    if (depth < 4) for (const entry of entries) if (entry.isDirectory() && entry.name !== 'node_modules') walk(path.join(root, entry.name), depth + 1);
  }
  for (const root of roots) walk(root);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillPrompt(command, config) {
  if (!command.skills?.length) return command.text;
  const catalog = listSkills(config);
  const selected = command.skills.map(name => {
    const skill = catalog.find(skill => skill.name === name);
    if (!skill) throw new Error(`技能不存在：${name}。请用 /skills 查询完整名称。`);
    return skill;
  });
  return `请使用以下技能完成任务；先读取对应 SKILL.md 并遵循其中适用的指令：\n${selected.map(skill => `${skill.name}: ${skill.file}`).join('\n')}\n\n任务：\n${command.text}`;
}
