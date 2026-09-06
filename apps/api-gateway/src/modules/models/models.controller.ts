import { Controller, Get, Logger } from '@nestjs/common';
import { OPENCODE_ZEN_MODEL_IDS, OPENCODE_ZEN_MODELS } from '../../common/constants/opencode-models';

const FALLBACK_MODELS_RESPONSE = {
  providers: [
    {
      id: 'openrouter',
      label: 'OpenRouter',
      models: [
        'deepseek/deepseek-v4-flash',
        'deepseek/deepseek-v4-pro',
        'z-ai/glm-5.2',
        'google/gemini-3.7-flash',
        'google/gemini-3.6-flash',
        'google/gemini-3.5-flash',
        'google/gemini-3.5-flash-lite',
        'x-ai/grok-4.6',
        'anthropic/claude-sonnet-4',
        'anthropic/claude-opus-4',
        'meta-llama/llama-4-maverick',
        'qwen/qwen3-coder',
        'mistralai/mistral-large-2501',
      ],
    },
    {
      id: 'nvidia',
      label: 'NVIDIA NIM',
      models: [
        'nvidia/nemotron-3-ultra-550b-a55b',
        'nvidia/nemotron-3-super-120b-a12b',
        'nvidia/nemotron-3-nano-30b-a3b',
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
        'nvidia/nemotron-3-embed-1b',
        'nvidia/nemotron-ocr-v2',
        'nvidia/nemotron-3.5-lightning',
        'nvidia/nemotron-4',
        'nvidia/llama-nemotron-embed-1b-v2',
        'nvidia/llama-nemotron-rerank-vl-1b-v2',
        'meta/llama-3.1-70b-instruct',
        'meta/llama-3.1-8b-instruct',
        'deepseek/deepseek-r1',
      ],
    },
    {
      id: 'openai',
      label: 'OpenAI — ChatGPT',
      models: ['gpt-5.6-luna', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini', 'gpt-3.5-turbo'],
    },
    {
      id: 'xai',
      label: 'xAI — Grok',
      models: ['grok-4.6', 'grok-3', 'grok-3-mini'],
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      models: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    },
    {
      id: 'ollama',
      label: 'Local (Ollama)',
      models: ['llama3.1', 'mistral', 'codellama', 'qwen3', 'deepseek-r1', 'gemma3', 'phi4'],
    },
    {
      id: 'opencode',
      label: 'OpenCode Zen',
      models: OPENCODE_ZEN_MODEL_IDS,
    },
    {
      id: 'huggingface',
      label: 'Hugging Face',
      models: [
        'Qwen/Qwen2.5-72B-Instruct',
        'Qwen/Qwen3-30B-A3B-Instruct-2507',
        'Qwen/Qwen3-4B',
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        'meta-llama/Llama-3.3-70B-Instruct',
        'meta-llama/Llama-3.1-8B-Instruct',
        'mistralai/Mistral-Small-3.2-24B-Instruct-2509',
        'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B',
        'deepseek-ai/DeepSeek-V3',
        'HuggingFaceTB/SmolLM2-1.7B-Instruct',
        'google/gemma-3-27b-it',
      ],
    },
    {
      id: 'omniroute',
      label: 'OmniRoute (free, keyless)',
      models: ['kimi-k2', 'claude-haiku-4', 'gpt-4o-mini-free', 'gemini-flash-free', 'deepseek-chat-free'],
    },
  ],
  defaultProvider: 'opencode',
  embedding: { provider: 'openrouter', model: 'nvidia/nemotron-3-embed-1b', dims: 2048 },
  rerank: { enabled: true, provider: 'openrouter', model: 'nvidia/llama-nemotron-rerank-vl-1b-v2' },
  catalog: {
    chatModels: [
      { name: 'Nemotron 3.5 Lightning', id: 'nvidia/nemotron-3.5-lightning', provider: 'nvidia', notes: 'Lightweight/task-specific model for code review, security, fast agent tasks' },
      { name: 'Nemotron 3 Ultra 550B', id: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia', notes: 'Large hybrid Mamba-Transformer MoE for complex coding, planning, long-running agents' },
      { name: 'Nemotron 3 Super 120B', id: 'nvidia/nemotron-3-super-120b-a12b', provider: 'nvidia', notes: '120B total / 12B active MoE — main agent/reasoning model' },
      { name: 'Nemotron 3 Nano Omni 30B', id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', provider: 'nvidia', notes: 'Multimodal — images, documents, screenshots, computer-use subagents' },
      { name: 'Nemotron 4', id: 'nvidia/nemotron-4', provider: 'nvidia', notes: 'Next-generation frontier model' },
      { name: 'DeepSeek V4 Flash', id: 'deepseek/deepseek-v4-flash', provider: 'openrouter', notes: 'Fast and efficient for everyday Q&A' },
      { name: 'DeepSeek V4 Pro', id: 'deepseek/deepseek-v4-pro', provider: 'openrouter', notes: 'Deep analysis and multi-step logic' },
      { name: 'GLM 5.2', id: 'z-ai/glm-5.2', provider: 'openrouter', notes: 'Strong at code and tool-calling' },
      { name: 'Gemini 3.7 Flash', id: 'google/gemini-3.7-flash', provider: 'openrouter', notes: 'Flagship Gemini — strong all-round RAG' },
      { name: 'Gemini 3.6 Flash', id: 'google/gemini-3.6-flash', provider: 'openrouter', notes: 'Previous-gen Flash — solid balance of speed and capability' },
      { name: 'Gemini 3.5 Flash', id: 'google/gemini-3.5-flash', provider: 'openrouter', notes: 'Cost-effective agentic Flash model' },
      { name: 'Gemini 3.5 Flash-Lite', id: 'google/gemini-3.5-flash-lite', provider: 'openrouter', notes: 'Fastest, most cost-effective Gemini' },
      { name: 'Grok 4.6', id: 'x-ai/grok-4.6', provider: 'openrouter', notes: 'Fast, sharp reasoning' },
      { name: 'Claude Sonnet 4', id: 'anthropic/claude-sonnet-4', provider: 'openrouter', notes: 'Balanced quality and speed' },
      { name: 'Claude Opus 4', id: 'anthropic/claude-opus-4', provider: 'openrouter', notes: 'Maximum quality reasoning' },
      { name: 'Llama 4 Maverick', id: 'meta-llama/llama-4-maverick', provider: 'openrouter', notes: 'Meta open model' },
      { name: 'Qwen3 Coder', id: 'qwen/qwen3-coder', provider: 'openrouter', notes: 'Coding specialist' },
      { name: 'Mistral Large', id: 'mistralai/mistral-large-2501', provider: 'openrouter', notes: 'Mistral flagship' },
      { name: 'Qwen 2.5 72B Instruct', id: 'Qwen/Qwen2.5-72B-Instruct', provider: 'huggingface', isFree: true, notes: 'HF — verified FREE on a Basic token; best all-round HF chat model' },
      { name: 'Llama 3.1 8B Instruct', id: 'meta-llama/Llama-3.1-8B-Instruct', provider: 'huggingface', isFree: true, notes: 'HF — verified FREE on a Basic token; fast chat model' },
      { name: 'Qwen3 30B Instruct', id: 'Qwen/Qwen3-30B-A3B-Instruct-2507', provider: 'huggingface', isFree: false, notes: 'HF — needs credits/PRO; 400 model_not_supported on Basic tokens' },
      { name: 'Llama 3.3 70B Instruct', id: 'meta-llama/Llama-3.3-70B-Instruct', provider: 'huggingface', isFree: false, notes: 'HF — Meta\'s strong open instruct model (likely needs credits/PRO)' },
      { name: 'Mistral Small 3.2', id: 'mistralai/Mistral-Small-3.2-24B-Instruct-2509', provider: 'huggingface', isFree: false, notes: 'HF — fast, efficient Mistral model' },
      { name: 'DeepSeek R1 Distill 32B', id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B', provider: 'huggingface', isFree: false, notes: 'HF — reasoning model' },
      { name: 'SmolLM2 1.7B', id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', provider: 'huggingface', isFree: false, notes: 'HF — 400 model_not_supported on Basic tokens; needs credits/PRO' },
      { name: 'GPT-5.6 Luna', id: 'gpt-5.6-luna', provider: 'openai', notes: 'OpenAI flagship' },
      { name: 'GPT-4o', id: 'gpt-4o', provider: 'openai', notes: 'Multimodal GPT' },
      { name: 'GPT-4o Mini', id: 'gpt-4o-mini', provider: 'openai', notes: 'Fast lightweight GPT' },
      { name: 'o3', id: 'o3', provider: 'openai', notes: 'Reasoning model' },
      { name: 'o4-mini', id: 'o4-mini', provider: 'openai', notes: 'Fast reasoning model' },
      { name: 'Grok 4.6 (Direct)', id: 'grok-4.6', provider: 'xai', notes: 'Direct xAI endpoint' },
      { name: 'Gemini 3.7 Flash (Direct)', id: 'gemini-3.7-flash', provider: 'gemini', notes: 'Direct Google AI Studio' },
      { name: 'Gemini 3.6 Flash (Direct)', id: 'gemini-3.6-flash', provider: 'gemini', notes: 'Direct Google AI Studio' },
      { name: 'Gemini 3.5 Flash (Direct)', id: 'gemini-3.5-flash', provider: 'gemini', notes: 'Direct Google AI Studio' },
      { name: 'Gemini 3.5 Flash-Lite (Direct)', id: 'gemini-3.5-flash-lite', provider: 'gemini', notes: 'Direct Google AI Studio' },
      ...OPENCODE_ZEN_MODELS.map((m) => ({
        name: m.name,
        id: m.id,
        provider: 'opencode',
        isFree: m.isFree,
        notes: m.isFree ? 'OpenCode Zen — free' : 'OpenCode Zen — recommended coding-agent model',
      })),
    ],
    embeddingModels: [
      { name: 'Nemotron Embed 1B', id: 'nvidia/nemotron-3-embed-1b', provider: 'openrouter', dims: 2048, notes: '2048-dim, 32768 context — the active index model' },
      { name: 'Llama Nemotron Embed 1B v2', id: 'nvidia/llama-nemotron-embed-1b-v2', provider: 'nvidia', dims: 1024, notes: 'Strong multilingual retrieval' },
    ],
    rerankModels: [
      { name: 'Llama Nemotron Rerank VL 1B v2', id: 'nvidia/llama-nemotron-rerank-vl-1b-v2', provider: 'openrouter', notes: 'Re-scores retrieval results for precision' },
    ],
  },
  presets: [
    { role: 'main', label: 'Primary RAG / chat', provider: 'opencode', model: 'deepseek-v4-flash-free', rating: 5, isFree: true, notes: 'DeepSeek V4 Flash Free — primary RAG and chat model' },
    { role: 'reasoning', label: 'Best reasoning', provider: 'opencode', model: 'nemotron-3-ultra-free', rating: 5, isFree: true, notes: 'Nemotron 3 Ultra Free — reasoning and difficult queries' },
    { role: 'fast', label: 'Fast secondary', provider: 'opencode', model: 'mimo-v2.5-free', rating: 4, isFree: true, notes: 'MiMo V2.5 Free — fast secondary model' },
    { role: 'experimental', label: 'Experimental', provider: 'opencode', model: 'big-pickle', rating: 3, isFree: true, notes: 'Big Pickle — experimental / fallback' },
    { role: 'fallback', label: 'Experiment / fallback', provider: 'opencode', model: 'laguna-s-2.1-free', rating: 3, isFree: true, notes: 'Laguna S 2.1 Free — experiment / fallback' },
    { role: 'main-openrouter', label: 'Main chatbot', provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', rating: 5, isFree: false, notes: 'Everyday Q&A over your documents' },
    { role: 'reasoning-openrouter', label: 'Best reasoning', provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', rating: 5, isFree: false, notes: 'Deep analysis and multi-step logic' },
    { role: 'coding', label: 'Coding / Agent', provider: 'openrouter', model: 'z-ai/glm-5.2', rating: 5, isFree: false, notes: 'Strong at code and tool-calling' },
    { role: 'flagship', label: 'NVIDIA flagship', provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b', rating: 5, isFree: false, notes: 'Largest Nemotron 3 for maximum quality' },
    { role: 'gemini', label: 'Google Gemini', provider: 'openrouter', model: 'google/gemini-3.7-flash', rating: 5, isFree: false, notes: 'Flagship Gemini — strong all-round RAG over documents' },
    { role: 'grok', label: 'Grok (x-ai)', provider: 'openrouter', model: 'x-ai/grok-4.6', rating: 5, isFree: false, notes: 'Grok flagship for fast, sharp reasoning' },
    { role: 'gpt', label: 'ChatGPT (OpenAI)', provider: 'openai', model: 'gpt-5.6-luna', rating: 5, isFree: false, notes: 'OpenAI GPT flagship — bring your own OpenAI key' },
    { role: 'grok-direct', label: 'Grok (xAI)', provider: 'xai', model: 'grok-4.6', rating: 5, isFree: false, notes: 'Direct xAI endpoint — bring your own xAI key' },
    { role: 'gemini-direct', label: 'Gemini (Google)', provider: 'gemini', model: 'gemini-3.7-flash', rating: 5, isFree: true, notes: 'Direct Google AI Studio — free tier with your own key' },
    { role: 'efficient', label: 'Quality + efficiency', provider: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b', rating: 5, isFree: false, notes: 'Great balance of quality and cost' },
    { role: 'fast-nvidia', label: 'Fast NVIDIA model', provider: 'nvidia', model: 'nvidia/nemotron-3-nano-30b-a3b', rating: 4, isFree: false, notes: 'Low latency, lightweight' },
    { role: 'vision', label: 'Vision / multimodal', provider: 'nvidia', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', rating: 4, isFree: false, notes: 'Image + text understanding' },
    { role: 'ocr', label: 'Document OCR', provider: 'nvidia', model: 'nvidia/nemotron-ocr-v2', rating: 4, isFree: false, notes: 'Multilingual OCR for PDF/document ingestion' },
    { role: 'lightning', label: 'Fast agent tasks', provider: 'nvidia', model: 'nvidia/nemotron-3.5-lightning', rating: 4, isFree: false, notes: 'Lightweight model for code review, security, fast agent tasks' },
    { role: 'claude', label: 'Claude (Anthropic)', provider: 'openrouter', model: 'anthropic/claude-sonnet-4', rating: 5, isFree: false, notes: 'Balanced Anthropic model for coding and analysis' },
    { role: 'hf-main', label: 'Hugging Face chat', provider: 'huggingface', model: 'Qwen/Qwen2.5-72B-Instruct', rating: 5, isFree: true, notes: 'HF — verified FREE on a Basic token; bring your own HF token (Settings → Hugging Face)' },
    { role: 'hf-fast', label: 'HF fast model', provider: 'huggingface', model: 'meta-llama/Llama-3.1-8B-Instruct', rating: 4, isFree: true, notes: 'HF — verified FREE on a Basic token' },
    { role: 'embed', label: 'RAG embedding', provider: 'openrouter', model: 'nvidia/nemotron-3-embed-1b', dims: 2048, rating: 5, notes: '2048-dim, 32768 context — the active index model' },
    { role: 'embed-multi', label: 'Multilingual embedding', provider: 'nvidia', model: 'nvidia/llama-nemotron-embed-1b-v2', dims: 1024, rating: 5, notes: 'Strong multilingual retrieval (different dims — needs reindex)' },
    { role: 'rerank', label: 'RAG reranking', provider: 'openrouter', model: 'nvidia/llama-nemotron-rerank-vl-1b-v2', rating: 5, notes: 'Re-scores retrieval results for precision' },
  ],
};

@Controller('models')
export class ModelsController {
  private readonly logger = new Logger(ModelsController.name);
  private readonly ragUrl = process.env.RAG_SERVICE_URL || 'http://127.0.0.1:8643';

  @Get()
  async getModels() {
    try {
      const upstream = await fetch(`${this.ragUrl}/api/models`, {
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (!upstream.ok) {
        this.logger.error(`rag-service /models responded with ${upstream.status}`);
        return FALLBACK_MODELS_RESPONSE;
      }
      return upstream.json();
    } catch (err) {
      this.logger.warn(`rag-service /models unreachable, using fallback: ${err}`);
      return FALLBACK_MODELS_RESPONSE;
    }
  }

  @Get('openrouter')
  async getOpenRouterModels(): Promise<{ reachable: boolean; models: unknown[] }> {
    try {
      const upstream = await fetch(`${this.ragUrl}/api/models/openrouter`, {
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (!upstream.ok) {
        this.logger.warn(`rag-service /openrouter/models responded with ${upstream.status}`);
        return { reachable: false, models: [] };
      }
      return (await upstream.json()) as { reachable: boolean; models: unknown[] };
    } catch (err) {
      this.logger.warn(`openrouter models lookup failed: ${err}`);
      return { reachable: false, models: [] };
    }
  }

  @Get('omniroute')
  async getOmniRouteModels(): Promise<{ reachable: boolean; models: unknown[] }> {
    // Internally fetch the REAL OmniRoute gateway (:20128/v1/models) with the
    // provisioned manage key and feed its model list to the UI. The gateway is
    // auto-started + keyed by OmniRouteService on login/bootstrap, so this is
    // the authoritative set of models the agent/chat can actually use.
    const base = (process.env.OMNIROUTE_BASE_URL || 'http://localhost:20128/v1').replace(/\/+$/, '');
    const key = process.env.OMNIROUTE_API_KEY || '';
    try {
      const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.warn(`real OmniRoute /models responded with ${res.status}`);
        return { reachable: false, models: [] };
      }
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      const models: unknown[] = [];
      const seen = new Set<string>();
      for (const item of data.data || []) {
        const id = String(item.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const namespace = id.split('/', 1)[0].toLowerCase() || 'omniroute';
        models.push({
          id,
          name: id,
          provider: namespace,
          isFree: isOmniRouteFreeModel(id, namespace),
        });
      }
      return { reachable: true, models };
    } catch (err) {
      this.logger.warn(`real OmniRoute models lookup failed: ${err instanceof Error ? err.message : err}`);
      return { reachable: false, models: [] };
    }
  }
}

function isOmniRouteFreeModel(id: string, _namespace: string): boolean {
  const lower = id.toLowerCase();
  // OmniRoute marks a model as free when "free" appears as a distinct token in
  // its id (e.g. auto/coding:free, auto/best-free, oc/mimo-v2.5-free,
  // oc/nemotron-3-ultra-free). Namespaces alone (oc, auto, …) are NOT a free
  // signal — oc/big-pickle, auto/pro-*, etc. are paid, so we must not flag
  // every id that merely contains "auto" or lives in a known namespace.
  return /(^|[/:._-])free([/._:-]|$)/.test(lower) || lower.endsWith(':free');
}
