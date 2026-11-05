import { afterEach, describe, expect, it } from 'vitest'
import { LlmService } from '../LlmService'
import { sanitizeSettings, sanitizeModelOptions } from '../SettingsService'
import { BaseLLMProvider } from '../../lib/providers/base'
import type { ModelInfo, ProviderSendOptions } from '../../lib/providers/base'
import { registerProvider } from '../../lib/providers/registry'
import { registerTool } from '../../lib/tools/registry'
import type { LLMRequest, LLMRequestMessage, ModelOptions, ProviderName, SavedReasoning, Settings, StreamChunk } from '../../../src/types'

/** Records each request and plays a script; reports whatever model info the test sets. */
class ScriptedProvider extends BaseLLMProvider {
  sent: ProviderSendOptions[] = []
  info: ModelInfo = { contextLength: null, capabilities: {} }
  /** Info reported once the model is loaded (after the first request). */
  infoAfterLoad: ModelInfo | null = null
  script: (request: number, options: ProviderSendOptions) => void = (_n, options) => options.onChunk({ type: 'text', content: 'ok' })

  sendStreaming(options: ProviderSendOptions) {
    this.sent.push({ ...options, messages: JSON.parse(JSON.stringify(options.messages)) })
    const request = this.sent.length
    queueMicrotask(() => {
      this.script(request, options)
      options.onChunk({ type: 'done' })
    })
    return { abort: () => {} }
  }

  override async getModelInfo(): Promise<ModelInfo> {
    return this.sent.length > 0 && this.infoAfterLoad ? this.infoAfterLoad : this.info
  }

  async listModels() { return [] }
}

let provider = new ScriptedProvider('', '')
for (const name of ['ollama', 'lmstudio', 'openrouter'] as const) {
  registerProvider({ name, displayName: 'Scripted', defaultBaseUrl: '', factory: () => provider })
}
registerTool({
  definition: { type: 'function', function: { name: 'noop', description: 'Does nothing', parameters: { type: 'object' } } },
  execute: async () => ({ ok: true })
})

afterEach(() => {
  provider = new ScriptedProvider('', '')
})

function settingsWith(name: ProviderName, model: string, options?: ModelOptions): Settings {
  const settings = sanitizeSettings(undefined)
  return {
    ...settings,
    providers: { ...settings.providers, [name]: { ...settings.providers[name], ...(options ? { modelOptions: { [model]: options } } : {}) } }
  }
}

const prompt = (content: string, extra: Partial<LLMRequestMessage> = {}): LLMRequestMessage => ({ role: 'user', content, timestamp: '2026-01-01T00:00:00.000Z', ...extra })

async function run(settings: Settings, request: Omit<LLMRequest, 'conversationId'>) {
  const service = new LlmService({ getSettings: () => settings, getSystemPrompt: () => 'system', timeZone: 'UTC' })
  const chunks: StreamChunk[] = []
  let reasoning: SavedReasoning | null = null
  await service.orchestrateStream(
    { conversationId: 'c', ...request },
    `ch-${Math.random()}`,
    { send: (chunk) => chunks.push(chunk), saveReasoning: (saved) => { reasoning = saved } },
    async (tc) => ({ ...tc, result: { ok: true } })
  )
  return { chunks, reasoning: reasoning as SavedReasoning | null, usage: chunks.find((c) => c.type === 'usage')?.usage }
}

describe('tools switch', () => {
  it('sends tools on Auto unless the server says the model can\'t use them; Off sends none, On sends them anyway', async () => {
    const cases: Array<{ options?: ModelOptions; tools?: boolean; expected: boolean }> = [
      { expected: true },
      { tools: true, expected: true },
      { tools: false, expected: false },
      { options: { tools: 'off' }, tools: true, expected: false },
      { options: { tools: 'on' }, tools: false, expected: true }
    ]
    for (const { options, tools, expected } of cases) {
      provider.info = { contextLength: null, capabilities: tools === undefined ? {} : { tools } }
      await run(settingsWith('openrouter', 'm', options), { model: 'm', provider: 'openrouter', messages: [prompt('q')] })
      expect(provider.sent.at(-1)!.tools.some((t) => t.function.name === 'noop')).toBe(expected)
    }
  })

  it('applies to the chat\'s own model only', async () => {
    await run(settingsWith('openrouter', 'other', { tools: 'off' }), { model: 'm', provider: 'openrouter', messages: [prompt('q')] })
    expect(provider.sent[0].tools.length).toBeGreaterThan(0)
  })
})

describe('images for local models', () => {
  const withImage = prompt('What is this?', {
    attachments: [{ kind: 'image', name: 'cat.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAEC' }]
  })
  const imageParts = () => {
    const user = provider.sent.at(-1)!.messages.find((m) => m.role === 'user')!
    return Array.isArray(user.content) ? user.content.filter((part) => part.type === 'image_url').length : 0
  }
  const userText = () => JSON.stringify(provider.sent.at(-1)!.messages.find((m) => m.role === 'user')!.content)

  it('go to Ollama and LM Studio only for models that report vision', async () => {
    for (const name of ['ollama', 'lmstudio'] as const) {
      provider.info = { contextLength: null, capabilities: { vision: true } }
      await run(settingsWith(name, 'm'), { model: 'm', provider: name, messages: [withImage] })
      expect(imageParts()).toBe(1)

      for (const capabilities of [{ vision: false }, {}]) {
        provider.info = { contextLength: null, capabilities }
        await run(settingsWith(name, 'm'), { model: 'm', provider: name, messages: [withImage] })
        expect(imageParts()).toBe(0)
        expect(userText()).toContain("Image 1: cat.png [not shown: this model didn't report image support]")
      }
    }
  })

  it('still go to cloud models, which report nothing', async () => {
    await run(settingsWith('openrouter', 'm'), { model: 'm', provider: 'openrouter', messages: [withImage] })
    expect(imageParts()).toBe(1)
  })
})

describe('context window for local models', () => {
  it('sends Ollama the set window, and fits the chat to it from the first request', async () => {
    provider.info = { contextLength: 4096, capabilities: {} }
    const { usage } = await run(settingsWith('ollama', 'm', { contextWindow: 16_384 }), { model: 'm', provider: 'ollama', messages: [prompt('q')] })
    expect(provider.sent[0].contextWindow).toBe(16_384)
    expect(usage?.contextLength).toBe(16_384)
  })

  it('leaves the window to the server when unset, and learns it once the model is loaded', async () => {
    provider.info = { contextLength: null, capabilities: {} }
    provider.infoAfterLoad = { contextLength: 4096, capabilities: {} }
    const { usage } = await run(settingsWith('ollama', 'm'), { model: 'm', provider: 'ollama', messages: [prompt('q')] })
    expect(provider.sent[0]).not.toHaveProperty('contextWindow')
    expect(usage?.contextLength).toBe(4096)
  })

  it('uses LM Studio\'s loaded window over the setting, and the setting when it loads the model', async () => {
    provider.info = { contextLength: 4096, capabilities: {} }
    const loaded = await run(settingsWith('lmstudio', 'm', { contextWindow: 16_384 }), { model: 'm', provider: 'lmstudio', messages: [prompt('q')] })
    expect(provider.sent[0].contextWindow).toBe(16_384)
    expect(loaded.usage?.contextLength).toBe(4096)

    provider = new ScriptedProvider('', '')
    const notLoaded = await run(settingsWith('lmstudio', 'm', { contextWindow: 16_384 }), { model: 'm', provider: 'lmstudio', messages: [prompt('q')] })
    expect(notLoaded.usage?.contextLength).toBe(16_384)
  })

  it('asks the local server again every turn, since models are reloaded with other windows', async () => {
    const settings = settingsWith('lmstudio', 'm')
    const service = new LlmService({ getSettings: () => settings, getSystemPrompt: () => 'system', timeZone: 'UTC' })
    const turn = async () => {
      const chunks: StreamChunk[] = []
      await service.orchestrateStream({ conversationId: 'c', model: 'm', provider: 'lmstudio', messages: [prompt('q')] }, `ch-${Math.random()}`, { send: (c) => chunks.push(c) }, async (tc) => tc)
      return chunks.find((c) => c.type === 'usage')?.usage?.contextLength
    }
    provider.info = { contextLength: 16_384, capabilities: {} }
    expect(await turn()).toBe(16_384)
    // Unloaded in LM Studio and loaded again at its default.
    provider.info = { contextLength: 4096, capabilities: {} }
    expect(await turn()).toBe(4096)
  })

  it('is never sent to cloud providers', async () => {
    await run(settingsWith('openrouter', 'm', { contextWindow: 16_384 }), { model: 'm', provider: 'openrouter', messages: [prompt('q')] })
    expect(provider.sent[0]).not.toHaveProperty('contextWindow')
  })
})

describe('Ollama reasoning', () => {
  it('goes back with each tool round, is saved, and is replayed on the next turn', async () => {
    provider.script = (request, options) => {
      options.onChunk({ type: 'thinking', content: `think ${request}` })
      if (request === 1) options.onChunk({ type: 'tool_call', toolCall: { id: 'c1', name: 'noop', arguments: {} } })
      else options.onChunk({ type: 'text', content: 'Done.' })
      options.onChunk({ type: 'reasoning_echo', reasoning: { thinking: `think ${request}` } })
    }
    const settings = settingsWith('ollama', 'qwen3')
    const turn1 = await run(settings, { model: 'qwen3', provider: 'ollama', messages: [prompt('q')] })
    expect(provider.sent[1].messages.find((m) => m.role === 'assistant')).toMatchObject({ tool_calls: [{ id: 'c1' }], thinking: 'think 1' })
    expect(turn1.reasoning?.rounds).toEqual([
      { round: 1, reasoning: { thinking: 'think 1' } },
      { round: 2, final: true, reasoning: { thinking: 'think 2' } }
    ])

    await run(settings, {
      model: 'qwen3',
      provider: 'ollama',
      messages: [
        prompt('q'),
        {
          role: 'assistant',
          content: 'Done.',
          timestamp: '',
          toolCalls: [{ id: 'c1', name: 'noop', arguments: {}, result: { ok: true }, round: 1, contentOffset: 0 }],
          savedReasoning: turn1.reasoning!
        },
        prompt('more')
      ]
    })
    const assistants = provider.sent.at(-1)!.messages.filter((m) => m.role === 'assistant')
    expect(assistants.map((m) => m.thinking)).toEqual(['think 1', 'think 2'])
    // Byte for byte what turn 1's last request sent, up to its end.
    const lastLive = provider.sent[1].messages
    expect(JSON.stringify(provider.sent.at(-1)!.messages.slice(0, lastLive.length))).toBe(JSON.stringify(lastLive))
  })
})

describe('model settings', () => {
  it('keeps only valid windows and switches, and drops models left at the defaults', () => {
    expect(sanitizeModelOptions({ contextWindow: 8192, tools: 'off' })).toEqual({ contextWindow: 8192, tools: 'off' })
    expect(sanitizeModelOptions({ contextWindow: 8192.5, tools: 'auto' })).toBeNull()
    expect(sanitizeModelOptions({ contextWindow: 10, tools: 'maybe' })).toBeNull()
    expect(sanitizeModelOptions('x')).toBeNull()

    const settings = sanitizeSettings({
      providers: {
        ...sanitizeSettings(undefined).providers,
        ollama: { apiKey: '', baseUrl: 'http://localhost:11434', models: [], modelOptions: { 'qwen3:4b': { contextWindow: 8192 }, ' ': { tools: 'on' }, gone: {} } as never }
      }
    })
    expect(settings.providers.ollama.modelOptions).toEqual({ 'qwen3:4b': { contextWindow: 8192 } })
    expect(settings.providers.openrouter).not.toHaveProperty('modelOptions')
  })
})
