import { emojiNumber } from './core.mjs';

export function catalogModels(catalog) {
  if (!Array.isArray(catalog?.providers)) throw new Error('T3 returned an invalid model catalog.');
  const entries = [];
  const keys = new Set();
  for (const provider of catalog.providers) {
    if (!provider.providerInstanceId || provider.constraints?.some(value => /provider instance is disabled/i.test(value))) continue;
    for (const model of provider.models || []) {
      if (!model.id) continue;
      const key = `${provider.providerInstanceId}::${model.id}`;
      if (keys.has(key)) continue;
      keys.add(key);
      entries.push({ key, provider: provider.providerInstanceId, model: model.id,
        label: model.label || model.id, options: model.options || [] });
    }
  }
  return entries;
}

// The saved numbering must follow the same provider groups as the display.
export function listedModels(catalog) {
  const groups = new Map();
  for (const entry of catalogModels(catalog)) {
    if (!groups.has(entry.provider)) groups.set(entry.provider, []);
    groups.get(entry.provider).push(entry);
  }
  return [...groups.values()].flat();
}

export function resolveModel(name, models, current) {
  const lower = name.toLowerCase();
  let matches = models.filter(entry => entry.key.toLowerCase() === lower);
  if (!matches.length) {
    matches = models.filter(entry => entry.model.toLowerCase() === lower);
    const local = matches.filter(entry => entry.provider === current.instanceId);
    if (local.length === 1) return local[0];
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error('Ambiguous model. Use /model <provider>::<model>:\n' + matches.map(entry => entry.key).join('\n'));
  throw new Error('Model not found or provider disabled. Use /models <search> and copy an exact model ID.');
}

export function modelSelection(entry, current) {
  const options = entry.provider === current.instanceId ? (current.options || []).filter(selection =>
    entry.options.some(option => option.id === selection.id && option.values?.includes(selection.value))) : [];
  return { instanceId: entry.provider, model: entry.model, options };
}

export function fastMode(config, catalog) {
  const selection = config?.modelSelection;
  if (!selection?.instanceId || !selection?.model) throw new Error('T3 未返回模型配置。');
  const entry = catalogModels(catalog).find(model => model.provider === selection.instanceId && model.model === selection.model);
  if (!entry) throw new Error('当前模型未出现在 T3 目录中，无法确认 Fast 状态。');
  const option = entry.options.find(value => value.id === 'serviceTier');
  if (!option?.values?.includes('priority') || !option.values.includes('default')) return { supported: false, enabled: false };
  const tier = selection.options?.find(value => value.id === 'serviceTier')?.value ?? option.default ?? 'default';
  return { supported: true, enabled: tier === 'priority' };
}

export function fastSelection(config, catalog, enabled) {
  const mode = fastMode(config, catalog);
  if (!mode.supported) throw new Error('当前提供商或模型不支持 Fast 模式，请用 /models 和 /model 选择支持的模型。');
  const selection = config.modelSelection;
  return { ...selection, options: [...(selection.options || []).filter(option => option.id !== 'serviceTier'),
    { id: 'serviceTier', value: enabled ? 'priority' : 'default' }] };
}

export function fastLabel(mode) {
  if (typeof mode?.supported !== 'boolean' || (mode.supported && typeof mode.enabled !== 'boolean')) {
    throw new Error('T3 未返回有效的 Fast 状态。');
  }
  return mode.supported ? mode.enabled ? '⚡ 已开启' : '⚪ 已关闭' : '当前模型不支持';
}

export function modelLabel(config) {
  const selection = config?.modelSelection;
  if (!selection?.instanceId || !selection?.model) throw new Error('T3 did not return the selected model.');
  const labels = { effort: '推理强度', reasoningEffort: '推理强度', reasoning_effort: '推理强度', verbosity: '回复详细度', serviceTier: '服务档位' };
  const options = (selection.options || []).map(option => `• ${labels[option.id] || option.id}：${option.value}`).join('\n');
  return `提供商：${selection.instanceId}\n模型：${selection.instanceId}::${selection.model}${options ? '\n\n【模型选项】\n' + options : ''}`;
}

export function formatModels(catalog, current, search) {
  const models = listedModels(catalog);
  const omitted = catalog.providers.filter(provider => !provider.constraints?.some(value => /provider instance is disabled/i.test(value)))
    .reduce((count, provider) => count + (provider.omittedModels || 0), 0);
  const groups = new Map();
  for (const [index, entry] of models.entries()) {
    if (!groups.has(entry.provider)) groups.set(entry.provider, []);
    groups.get(entry.provider).push(`${emojiNumber(index + 1)} ${entry.provider === current.instanceId && entry.model === current.model ? '⭐ ' : ''}${entry.key}`);
  }
  return [search ? `【模型搜索】\n关键词：${search.replace(/[\r\n]/g, ' ')}` : '【可用模型】',
    `显示 ${models.length} 个模型 · ⭐ 当前选中`, `当前：${current.instanceId}::${current.model}`, '',
    ...[...groups].map(([provider, lines]) => `〈${provider}〉\n${lines.join('\n')}\n`),
    ...(models.length ? [] : ['未找到匹配的模型。', '']),
    ...(omitted ? [`另有 ${omitted} 个目录条目未展开。`, '搜索：/models <关键词>', ''] : []),
    '【切换模型】', '/model <序号>  或  /模型 <序号>', '/model <模型ID>', '/model <提供商>::<模型ID>',
    '序号对应当前线程最近一次模型列表；重新查询或搜索会更新编号。', '',
    '模型可用性取决于提供商登录和账户权限。',
  ].join('\n');
}
