// Thin API client for the static dashboard.
const SUPERDS_LOCAL_KEY = '<your superglm gateway key>';
const SUPERGLM_KEY_STORAGE = 'superglm_gateway_key';
window.SUPERDS_BASE_URL = window.location.origin;
window.SUPERDS_OPENAI_BASE_URL = `${window.location.origin}/openai/v1`;
window.SUPERDS_DISPLAY_KEY = '<your superglm gateway key>';

function gatewayKey({ promptIfMissing = true } = {}) {
  try {
    const stored = window.sessionStorage.getItem(SUPERGLM_KEY_STORAGE) || window.localStorage.getItem(SUPERGLM_KEY_STORAGE);
    if (stored) return stored;
    if (!promptIfMissing || !window.prompt) return '';
    const entered = window.prompt('输入 superglm gateway key（SUPERDS_LOCAL_API_KEY）');
    if (entered && entered.trim()) {
      window.sessionStorage.setItem(SUPERGLM_KEY_STORAGE, entered.trim());
      return entered.trim();
    }
  } catch {
    // storage/prompt unavailable
  }
  return '';
}

async function apiJson(path, options = {}) {
  const needsAuth = options.auth !== false && path !== '/api/health';
  const token = needsAuth ? gatewayKey() : '';
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && needsAuth) {
    try { window.sessionStorage.removeItem(SUPERGLM_KEY_STORAGE); } catch {}
    const retryToken = gatewayKey();
    if (retryToken && retryToken !== token) {
      return apiJson(path, options);
    }
  }
  if (!res.ok) {
    throw new Error(data?.detail?.message || data?.detail || data?.error?.message || res.statusText);
  }
  return data;
}

function maskKey(provider) {
  if (provider.api_key) return 'key-************configured';
  return provider.api_key_env ? `$${provider.api_key_env}` : '—';
}

function providerColor(id) {
  const colors = {
    deepseek: '#5eead4',
    qwen: '#c084fc',
    openrouter: '#fb923c',
    kimi: '#60a5fa',
    siliconflow: '#4ade80',
    litellm: '#fbbf24',
    ollama: '#a8aeb8',
    vllm: '#4ade80',
  };
  return colors[id] || '#a8aeb8';
}

function toProviderCard(provider) {
  const id = provider.id || provider.name || 'provider';
  return {
    ...provider,
    id,
    name: provider.name || id,
    protocol: provider.protocol === 'anthropic' ? 'Anthropic 兼容' : 'OpenAI 兼容',
    baseUrl: provider.base_url || provider.baseUrl || '',
    apiKeyEnv: provider.api_key_env || provider.apiKeyEnv || '',
    apiKeyStatus: provider.api_key ? 'configured' : 'missing',
    apiKeyMask: provider.apiKeyMask || maskKey(provider),
    defaultModel: provider.default_model || provider.defaultModel || '',
    lastTested: provider.last_tested || '尚未测试',
    latency: provider.latency_ms || null,
    status: provider.status || (provider.api_key ? 'unknown' : 'failed'),
    color: providerColor(id),
    short: (provider.name || id).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'AI',
  };
}

function toWorkerProvider(provider) {
  return {
    id: provider.id,
    name: provider.name || provider.id,
    protocol: provider.protocol === 'Anthropic 兼容' || provider.protocol === 'anthropic' ? 'anthropic' : 'openai',
    base_url: provider.base_url || provider.baseUrl || '',
    api_key: provider.api_key || provider.apiKey || '',
    api_key_env: provider.api_key_env || provider.apiKeyEnv || '',
    default_model: provider.default_model || provider.defaultModel || '',
    capabilities: provider.capabilities || (provider.suggestedModels ? { models: provider.suggestedModels } : undefined),
    degraded_threshold_ms: provider.degraded_threshold_ms || 60000,
  };
}

function toWorkerProfile(profile) {
  const out = { ...profile };
  delete out.set_default;
  return out;
}

function modelsFromProviders(providers) {
  return providers.flatMap(p => {
    const card = toProviderCard(p);
    const models = new Set([
      card.defaultModel,
      ...(p.capabilities?.models || p.suggested_models || p.suggestedModels || []),
    ].filter(Boolean));
    return Array.from(models).map(model => ({
      id: `${card.id}/${model}`,
      provider_id: card.id,
      actual_model: model,
      litellm_model: model,
      role: 'main',
      capabilities: p.capabilities || {},
    }));
  });
}

const WORKER_PROVIDER_PRESETS = [
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    category: 'coding',
    protocol: 'openai',
    base_url: 'https://api.siliconflow.cn/v1',
    api_key_env: 'SILICONFLOW_API_KEY',
    default_model: 'zai-org/GLM-5.2',
    suggested_models: ['zai-org/GLM-5.2', 'Qwen/Qwen3-Coder-480B-A35B-Instruct'],
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI',
    category: 'coding',
    protocol: 'openai',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key_env: 'ZHIPU_API_KEY',
    default_model: 'glm-5.2',
    suggested_models: ['glm-5.2', 'glm-4.5'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'aggregator',
    protocol: 'openai',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_env: 'OPENROUTER_API_KEY',
    default_model: 'anthropic/claude-3.5-sonnet',
    suggested_models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o-mini'],
  },
  {
    id: 'vllm-local',
    name: 'vLLM 本地',
    category: 'local',
    protocol: 'openai',
    base_url: 'http://127.0.0.1:8000/v1',
    api_key_env: '',
    default_model: 'local-model',
    suggested_models: ['local-model'],
  },
];

function fromBackendTrace(t) {
  const started = t.started_at ? new Date(t.started_at * 1000) : new Date();
  const usage = t.usage || {};
  const request = t.request || {};
  const response = t.response || {};
  const sanitizer = t.sanitizer || {};
  return {
    id: t.trace_id,
    time: window.fmtTime ? window.fmtTime(started) : started.toLocaleTimeString(),
    client: t.client_name || t.client_protocol || 'unknown',
    incomingModel: t.incoming_model || '',
    resolvedModel: t.upstream_model || '',
    status: t.status === 'error' ? 'err' : t.status,
    latencyMs: t.latency_ms || 0,
    inputTokens: usage.inputTokens || usage.input_tokens || 0,
    outputTokens: usage.outputTokens || usage.output_tokens || 0,
    costUsd: usage.estimatedCostUsd || 0,
    sanitizer: sanitizer.billingHeaderAction === 'stripped' ? 'cch stripped' : sanitizer.billingHeaderAction || '已透传',
    streamed: Boolean(request.body && request.body.stream),
    fallback: Array.isArray(request.route_attempts) && request.route_attempts.length > 1,
    steps: (t.steps || []).map(s => ({
      name: s.name,
      status: s.status === 'error' ? 'err' : s.status,
      summary: s.summary,
      durationMs: s.durationMs || 0,
    })),
    request,
    response,
    raw: t,
  };
}

window.SuperDSApi = {
  localKey: SUPERDS_LOCAL_KEY,
  async health() {
    const data = await apiJson('/api/health', { auth: false });
    return {
      ok: data.ok,
      service: data.service || 'superglm',
      time: data.time,
      mode: data.mode || 'observe',
      local_base_url: window.location.origin,
      aliases: data.aliases || 0,
      haiku_alias_enabled: Boolean(data.haiku_alias_enabled),
    };
  },
  async providers() {
    const data = await apiJson('/api/providers');
    return (data.data || data.providers || []).map(toProviderCard);
  },
  async presets() {
    try {
      const data = await apiJson('/api/provider-presets');
      return data.data || [];
    } catch {
      return WORKER_PROVIDER_PRESETS;
    }
  },
  async traces(limit = 100) {
    const data = await apiJson(`/api/traces?limit=${limit}`);
    const rows = (data.data || data.traces || []).map(fromBackendTrace);
    return rows.length ? rows : window.TRACES;
  },
  async modelCapabilities() {
    try {
      const data = await apiJson('/api/model-capabilities');
      return data.data || [];
    } catch {
      const cfg = await apiJson('/api/config');
      const models = (cfg.models && cfg.models.length) ? cfg.models : modelsFromProviders(cfg.providers || []);
      return models.map(m => ({ id: m.id, ...(m.capabilities || {}) }));
    }
  },
  async profiles() {
    const [profilesData, configData, providersData] = await Promise.all([
      apiJson('/api/profiles'),
      apiJson('/api/config'),
      apiJson('/api/providers'),
    ]);
    const providers = providersData.providers || providersData.data || configData.providers || [];
    const models = (configData.models && configData.models.length) ? configData.models : modelsFromProviders(providers);
    return {
      profiles: profilesData.data || profilesData.profiles || [],
      models,
      providers: providers.map(toProviderCard),
      defaultProfile: configData.runtime?.default_profile || 'default',
    };
  },
  async saveProfile(profile, setDefault = false) {
    const saved = await apiJson('/api/profiles', {
      method: 'POST',
      body: JSON.stringify(toWorkerProfile(profile)),
    });
    if (setDefault) {
      const config = await apiJson('/api/config');
      await apiJson('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ ...config, runtime: { ...(config.runtime || {}), default_profile: profile.id } }),
      });
    }
    return { ok: true, profile: saved.profile || saved, default_profile: setDefault ? profile.id : undefined };
  },
  async visionCheck(modelId) {
    try {
      return await apiJson('/api/vision-check', {
        method: 'POST',
        body: JSON.stringify({ model_id: modelId }),
      });
    } catch {
      return { model_id: modelId, vision_status: 'unknown', ok: true };
    }
  },
  async saveProvider(provider) {
    const payload = toWorkerProvider(provider);
    const data = await apiJson('/api/providers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return data.provider || data;
  },
  async deleteProvider(providerId) {
    return apiJson(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: 'DELETE',
    });
  },
  async testConnection({ providerId, model, provider } = {}) {
    return apiJson('/api/test-connection', {
      method: 'POST',
      body: JSON.stringify({ provider_id: providerId, model, ...(provider ? toWorkerProvider(provider) : {}) }),
    });
  },
  async routerStatus() {
    try {
      return await apiJson('/api/router/status');
    } catch {
      return { circuit_breakers: {} };
    }
  },
  async claudeSmoke() {
    const key = gatewayKey();
    return apiJson('/v1/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Super DeepSeek smoke test.' }],
      }),
    });
  },
};
