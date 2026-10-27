import { CONFIG_KEYS, readProjectEnv, providerConfig, createProvider } from './config.js';
import { getProvider, providerNames } from './providers/index.js';
import { loginCodex, readCodexAuth } from './providers/codex-auth.js';
import { HttpProvider } from './providers/http-provider.js';
import { listProviderModels } from './providers/model-list.js';
import { loadModelCatalog, enrichModels, catalogModels, reasoningChoices } from './providers/model-catalog.js';
import { endpointBase } from './providers/http-common.js';
import { readUserConfig, saveUserConfig, userConfigPath } from './user-config.js';
import { TerminalUi, UiCanceled } from './terminal-ui.js';

const labels = { mock: '本地固定回答', zhipu: '智谱 GLM', openai: 'OpenAI API', 'openai-codex': 'OpenAI / ChatGPT 订阅（OAuth）',
  anthropic: 'Anthropic Claude', gemini: 'Google Gemini', deepseek: 'DeepSeek', openrouter: 'OpenRouter', moonshot: 'Moonshot / Kimi',
  qwen: '通义千问', minimax: 'MiniMax', groq: 'Groq', mistral: 'Mistral', ollama: 'Ollama 本机模型', 'openai-compatible': '自定义兼容接口' };
const prefixFor = provider => provider.replaceAll('-', '_').toUpperCase();

export function validateTuiConfig(env, provider) {
  const config = providerConfig({ env, provider });
  if (provider === 'openai-codex') new HttpProvider({ ...config, apiKey: 'configuration-validation' });
  else createProvider({ ...config, apiKey: config.apiKey || 'configuration-validation' });
  return config;
}

export async function runConfigTui({ env = process.env, path = userConfigPath({ env }), projectPath = '.env.local', ui,
  login = loginCodex, listModels = listProviderModels, catalogLoader = loadModelCatalog, checkProvider = createProvider } = {}) {
  const terminal = ui ?? new TerminalUi(); let result;
  try {
    let record = readUserConfig({ path });
    const legacy = readProjectEnv(projectPath);
    const inherited = Object.fromEntries(CONFIG_KEYS.filter(k => env[k] !== undefined).map(k => [k, env[k]]));
    const base = () => ({ ...env, ...legacy, ...inherited, ...record.values });
    const known = new Set(record.providers.filter(p => providerNames.includes(p)));
    const initial = base();
    for (const provider of providerNames) if (initial.NOTIONSI_PROVIDER === provider || getProvider(provider).envKeys.some(key => initial[key])) known.add(provider);
    let active = inherited.NOTIONSI_PROVIDER ?? record.values.NOTIONSI_PROVIDER ?? legacy.NOTIONSI_PROVIDER;
    if (!providerNames.includes(active)) active = undefined;
    let catalog;
    const getCatalog = async signal => {
      if (catalog === undefined) catalog = await catalogLoader({ env, signal });
      signal?.throwIfAborted(); return catalog;
    };
    const commit = (values, providers = [...known]) => {
      record = saveUserConfig(values, { path, providers, expectedSource: record.source });
      result = { saved: true, path, provider: values.NOTIONSI_PROVIDER };
    };

    async function configure(provider) {
      const prefix = prefixFor(provider), changes = {};
      const candidate = () => ({ ...base(), ...changes, NOTIONSI_PROVIDER: provider });
      const config = () => ({ ...getProvider(provider).configure({ env: candidate() }), name: provider, provider });
      async function editEndpoint() {
        let current = candidate()[`${prefix}_BASE_URL`] ?? '';
        if (!current) { try { current = config().baseUrl ?? ''; } catch {} }
        const next = await terminal.inputValue('API 根地址', { initial: current, note: '填写根地址，例如 https://api.example.com/v1。' });
        if (next === null) return false;
        changes[`${prefix}_BASE_URL`] = endpointBase(next.trim()); return true;
      }
      async function authenticate() {
        if (provider === 'mock') return true;
        if (provider === 'openai-compatible' && !candidate()[`${prefix}_BASE_URL`] && !await editEndpoint()) return false;
        for (;;) {
          if (provider === 'openai-codex') {
            let signedIn = false; try { readCodexAuth(config().authFile); signedIn = true; } catch {}
            const action = await terminal.choose('2/5 · OAuth 登录', [
              ...(signedIn ? [{ value: 'keep', label: '使用已有的 ChatGPT / Codex 登录' }] : []),
              { value: 'oauth', label: signedIn ? '重新进行 OAuth 登录' : '进行 OAuth 登录' },
              { value: 'auth-settings', label: '设置登录程序与凭据路径' }, { value: 'cancel', label: '取消配置' },
            ], { note: '登录后将自动获取订阅通道的模型列表。' });
            if (action === undefined || action === 'cancel') return false;
            if (action === 'keep') return true;
            if (action === 'oauth') { await terminal.external(() => login(config())); return true; }
            if (action === 'auth-settings') {
              for (const [key, title, value] of [['OPENAI_CODEX_CLI', 'Codex CLI 路径（可选）', config().codexCli ?? ''],
                ['OPENAI_CODEX_AUTH_FILE', 'OAuth 凭据文件', config().authFile]]) {
                const next = await terminal.inputValue(title, { initial: value }); if (next !== null) changes[key] = next.trim();
              }
            }
          } else {
            const key = `${prefix}_API_KEY`, existing = candidate()[key];
            const optional = provider === 'ollama' || provider === 'openai-compatible';
            const action = await terminal.choose('2/5 · 配置供应商凭据', [
              ...(existing ? [{ value: 'keep', label: '使用已有 API Key（隐藏）' }] : []),
              { value: 'key', label: existing ? '替换 API Key（隐藏输入）' : '填写 API Key（隐藏输入）' },
              ...(optional ? [{ value: 'no-key', label: '此接口无需 API Key' }] : []),
              ...(provider !== 'zhipu' ? [{ value: 'endpoint', label: '修改 API 根地址' }] : []),
              { value: 'cancel', label: '取消配置' },
            ], { note: '凭据只用于当前供应商，不会发送到 models.dev。' });
            if (action === undefined || action === 'cancel') return false;
            if (action === 'keep') return true;
            if (action === 'no-key') { changes[key] = ''; return true; }
            if (action === 'endpoint') { await editEndpoint(); continue; }
            if (action === 'key') {
              const next = await terminal.inputValue('填写 API Key', { secret: true });
              if (next === null) continue;
              if (!next.trim() && existing) return true;
              if (!next.trim() || /[\r\n\0]/.test(next)) { await terminal.message('Key 未填写', '请输入有效的单行 API Key。'); continue; }
              changes[key] = next.trim(); return true;
            }
          }
        }
      }
      async function fetchModels() {
        for (;;) {
          try {
            return await terminal.task('3/5 · 从供应商获取模型列表', async signal => {
              const [live, metadata] = await Promise.allSettled([listModels(config(), { signal, details: true }), getCatalog(signal)]);
              signal.throwIfAborted();
              if (live.status === 'rejected') throw live.reason;
              if (!Array.isArray(live.value) || !live.value.length) throw new Error('供应商没有返回模型。');
              return enrichModels(live.value, metadata.status === 'fulfilled' ? metadata.value : {}, provider, config());
            });
          } catch (error) {
            if (error instanceof UiCanceled) throw error;
            if (error?.name === 'AbortError') return null;
            const action = await terminal.choose('获取模型列表失败', [
              { value: 'retry', label: '重试获取供应商模型列表' }, { value: 'credentials', label: '重新配置凭据或接口' },
              { value: 'catalog', label: '改用 models.dev 参考目录（需自行确认账号权限）' },
              { value: 'manual', label: '手动填写模型 ID' }, { value: 'cancel', label: '取消配置' },
            ], { note: error.message });
            if (action === undefined || action === 'cancel') return null;
            if (action === 'credentials' && !await authenticate()) return null;
            if (action === 'catalog') {
              const data = await terminal.task('读取 models.dev 参考目录', getCatalog);
              const models = catalogModels(data, provider, config());
              if (models.length) return models;
              await terminal.message('参考目录不可用', '没有此供应商的目录数据，请重试供应商接口或手动填写模型。');
            }
            if (action === 'manual') {
              const id = await terminal.inputValue('模型 ID', { initial: candidate()[`${prefix}_MODEL`] ?? '' });
              if (id === null) continue;
              if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:+\-]{0,199}$/.test(id.trim())) { await terminal.message('模型 ID 无效', '请输入有效的模型 ID。'); continue; }
              return enrichModels([{ id: id.trim(), source: 'manual' }], catalog ?? {}, provider, config());
            }
          }
        }
      }

      if (provider === 'zhipu') {
        const profile = await terminal.choose('智谱接口类型', [{ value: 'standard', label: '标准 API' }, { value: 'coding-cn', label: 'Coding Plan CN' }],
          { initial: candidate().ZHIPU_API_PROFILE === 'coding-cn' ? 1 : 0 });
        if (profile === undefined) return; changes.ZHIPU_API_PROFILE = profile;
      }
      if (!await authenticate()) return;
      const models = provider === 'mock' ? [{ id: 'mock', name: '本地固定回答' }] : await fetchModels();
      if (!models) return;
      for (;;) {
        const id = await terminal.choose('4/5 · 选择模型', models.map(m => ({ value: m.id, label: m.name === m.id || !m.name ? m.id : `${m.name} · ${m.id}` })),
          { initial: Math.max(0, models.findIndex(m => m.id === candidate()[`${prefix}_MODEL`])),
            note: models[0].source === 'models.dev' ? '来源：models.dev 参考目录，不代表当前账号一定可用。' : '来源：供应商接口。思考能力优先采用供应商信息，并由 models.dev 补充。' });
        if (id === undefined) return;
        const model = models.find(m => m.id === id), levels = reasoningChoices(provider, model);
        const budget = candidate()[`${prefix}_THINKING_BUDGET`];
        const previous = budget ? `budget:${budget}` : candidate()[`${prefix}_REASONING_EFFORT`] ?? '';
        const effort = await terminal.choose('5/5 · 选择思考强度', levels, { initial: Math.max(0, levels.findIndex(l => l.value === previous)),
          note: levels.length === 1 ? '该模型没有已确认的可调思考选项，将使用模型默认设置。' : '只展示当前模型有能力数据支持的选项。' });
        if (effort === undefined) continue;
        if (provider !== 'mock') {
          changes[`${prefix}_MODEL`] = id;
          changes[`${prefix}_REASONING_EFFORT`] = effort.startsWith('budget:') || effort.startsWith('toggle:') ? '' : effort;
          if (['anthropic', 'gemini'].includes(provider)) changes[`${prefix}_THINKING_BUDGET`] = effort.startsWith('budget:') ? effort.slice(7) : '';
          if (effort.startsWith('budget:')) {
            const minimumOutput = Number(effort.slice(7)) + 4096;
            changes[`${prefix}_MAX_TOKENS`] = String(Math.max(config().maxTokens, minimumOutput));
          }
          if (provider === 'zhipu') changes.ZHIPU_THINKING = effort.startsWith('toggle:') ? effort.slice(7) :
            (effort || /^glm-5\.3(?:-|$)/i.test(id) ? 'enabled' : 'disabled');
        }
        const action = await terminal.choose('完成配置', [{ value: 'save', label: '保存并启用此供应商和模型' }, { value: 'model', label: '重新选择模型' }, { value: 'cancel', label: '取消，放弃本次配置' }],
          { note: `${labels[provider]} · ${id} · ${levels.find(l => l.value === effort).label}` });
        if (action === undefined || action === 'cancel') return;
        if (action === 'model') continue;
        validateTuiConfig(candidate(), provider);
        const values = { ...record.values, NOTIONSI_PROVIDER: provider }, selected = candidate();
        for (const key of getProvider(provider).envKeys) if (selected[key] !== undefined) values[key] = selected[key];
        commit(values, [...new Set([...known, provider])]); known.add(provider); active = provider;
        await terminal.message('已保存并启用', `${labels[provider]} · ${id}\n${path}`); return;
      }
    }

    async function advanced() {
      const changes = {};
      const fields = [ { key: 'NOTIONSI_TOOLS', label: 'Notion 工具', options: ['off', 'native'] },
        { key: 'NOTIONSI_LOG_CONTENT', label: '终端回复正文', options: ['1', '0'] }, { key: 'NOTIONSI_SYSTEM_PROMPT_FILE', label: '系统提示词文件' },
        { key: 'NOTION_PATH', label: 'Notion 安装路径' },
        ...(active && active !== 'mock' ? [ ...(active !== 'openai-codex' ? [{ key: `${prefixFor(active)}_MAX_TOKENS`, label: '输出 Token 上限' }] : []),
          { key: `${prefixFor(active)}_TIMEOUT_MS`, label: '模型请求超时（毫秒）' } ] : []) ];
      for (;;) {
        const value = key => changes[key] ?? base()[key] ?? '';
        const action = await terminal.choose('其他配置', [...fields.map(f => ({ value: f.key, label: `${f.label}：${value(f.key) || '默认'}` })),
          { value: 'save', label: '保存其他配置' }, { value: 'back', label: '返回' }]);
        if (action === undefined || action === 'back') return;
        if (action === 'save') {
          if (active) validateTuiConfig({ ...base(), ...changes }, active);
          commit({ ...record.values, ...changes }); await terminal.message('已保存', path); return;
        }
        const field = fields.find(f => f.key === action);
        const next = field.options ? await terminal.choose(field.label, field.options.map(v => ({ value: v, label: v }))) :
          await terminal.inputValue(field.label, { initial: value(field.key) });
        if (next !== null && next !== undefined) changes[field.key] = next.trim();
      }
    }

    for (;;) {
      const model = active ? base()[`${prefixFor(active)}_MODEL`] : '';
      const action = await terminal.choose('配置', [ { value: 'add', label: '添加供应商' },
        ...(known.size ? [{ value: 'configure', label: '重新选择供应商并配置模型' }, { value: 'test', label: '测试当前模型连接（会调用模型）' }] : []),
        { value: 'advanced', label: '其他配置' }, { value: 'exit', label: '退出配置' } ],
      { note: active ? `当前：${labels[active]}${model ? ` / ${model}` : ''}` : '尚未添加供应商，请先选择“添加供应商”。' });
      if (action === undefined || action === 'exit') break;
      try {
        if (action === 'add' || action === 'configure') {
          const providers = action === 'add' ? providerNames.filter(p => !known.has(p)) : providerNames.filter(p => known.has(p));
          if (!providers.length) { await terminal.message('已添加全部供应商', '请返回并选择已有供应商配置模型。'); continue; }
          const provider = await terminal.choose(action === 'add' ? '1/5 · 添加供应商：选择提供商' : '1/5 · 选择已添加的供应商',
            providers.map(p => ({ value: p, label: `${labels[p]} (${p})${p === active ? ' · 当前' : ''}` })), { initial: Math.max(0, providers.indexOf(active)) });
          if (provider) await configure(provider);
        } else if (action === 'advanced') await advanced();
        else if (action === 'test') {
          if (!active) { await terminal.message('尚未启用模型', '请先完成供应商与模型配置。'); continue; }
          const config = providerConfig({ env: base(), provider: active }), instance = checkProvider(config);
          if (!instance) { await terminal.message('本地固定回答', '无需连接模型服务。'); continue; }
          await terminal.task('测试当前模型连接', async signal => {
            for await (const _chunk of instance.stream({ messages: [{ role: 'user', content: '请只回复：连接成功' }], signal })) { /* Settings never echo model content. */ }
          });
          await terminal.message('连接成功', `${labels[active]} · ${config.model}`);
        }
      } catch (error) {
        if (error instanceof UiCanceled) throw error;
        await terminal.message('操作未完成', error.name === 'AbortError' ? '当前操作已取消。' : error.message);
      }
    }
  } catch (error) { if (!(error instanceof UiCanceled)) throw error; }
  finally { terminal.close(); }
  return result ?? { saved: false };
}
