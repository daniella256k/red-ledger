import { afterEach, describe, expect, it } from 'vitest'
import { LlmService, buildPastReplyMessages, estimateUsage, savedReasoningLookup } from '../LlmService'
import { ConversationService } from '../ConversationService'
import { ChatTransferService } from '../ChatTransferService'
import { toRequestMessages } from '../TurnService'
import { sanitizeSettings } from '../SettingsService'
import { BaseLLMProvider } from '../../lib/providers/base'
import type { LLMMessage, ProviderSendOptions, ReasoningEcho } from '../../lib/providers/base'
import { registerProvider } from '../../lib/providers/registry'
import { registerTool } from '../../lib/tools/registry'
import { parseSavedReasoning } from '../../lib/savedReasoning'
import type { LLMRequest, LLMRequestMessage, SavedReasoning, Settings, ToolCall } from '../../../src/types'

const BASE_URL = 'https://openrouter.example/api/v1'
const MODEL = 'anthropic/claude-sonnet-5.5'

/** What a Claude model sends through OpenRouter: signed text, sometimes an encrypted block too. */
function echoFor(round: number): ReasoningEcho {
  return {
    reasoning_details: [
      { type: 'reasoning.text', text: `Thinking in round ${round}.`, signature: `sig-${round}-${'A'.repeat(40)}`, format: 'anthropic-claude-v1', index: 0 },
      ...(round % 3 === 0 ? [{ type: 'reasoning.encrypted', data: `enc-${round}`, format: 'anthropic-claude-v1', index: 1 }] : [])
    ]
  }
}

/**
 * A provider that plays a script: each request gets the next round, which
 * may write text, call tools and return reasoning. Every request is kept as
 * the JSON the server would receive.
 */
class ScriptedProvider extends BaseLLMProvider {
  requests: LLMMessage[][] = []
  script: (request: number, options: ProviderSendOptions) => void = () => {}

  sendStreaming(options: ProviderSendOptions) {
    this.requests.push(JSON.parse(JSON.stringify(options.messages)))
    const request = this.requests.length
    queueMicrotask(() => {
      this.script(request, options)
      options.onChunk({ type: 'done' })
    })
    return { abort: () => {} }
  }

  async listModels() { return [] }
}

const provider = new ScriptedProvider('', '')
registerProvider({ name: 'openrouter', displayName: 'Scripted', defaultBaseUrl: '', factory: () => provider })
registerProvider({ name: 'custom', displayName: 'Scripted', defaultBaseUrl: '', factory: () => provider })
registerTool({
  definition: { type: 'function', function: { name: 'noop', description: 'Does nothing', parameters: { type: 'object' } } },
  execute: async () => ({ ok: true })
})

function settingsWith(baseUrl: string, providerName: 'openrouter' | 'custom' = 'openrouter'): Settings {
  const settings = sanitizeSettings(undefined)
  return { ...settings, providers: { ...settings.providers, [providerName]: { ...settings.providers[providerName], baseUrl } } }
}

const services: ConversationService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.close()
  provider.requests = []
})

function database(): ConversationService {
  const service = new ConversationService(':memory:')
  services.push(service)
  return service
}

/** A turn run through the live tool loop and saved the way TurnService saves a reply. */
async function runTurn(service: LlmService, request: LLMRequest, channel: string) {
  let content = ''
  let toolCalls: ToolCall[] = []
  let reasoning: SavedReasoning | null = null
  await service.orchestrateStream(request, channel, {
    send: (chunk) => {
      if (chunk.type === 'text') content += chunk.content ?? ''
      if (chunk.type === 'tool_call' && chunk.toolCall) toolCalls.push({ ...chunk.toolCall, contentOffset: content.length })
      if (chunk.type === 'tool_result' && chunk.toolCall) {
        const result = chunk.toolCall
        toolCalls = toolCalls.map((tc) => (tc.id === result.id ? { ...result, contentOffset: tc.contentOffset } : tc))
      }
    },
    saveReasoning: (saved) => { reasoning = saved }
  }, async (tc) => ({ ...tc, result: { ok: true } }))
  return { content, toolCalls, reasoning: reasoning as SavedReasoning | null }
}

/** Saves a turn's reply in a real database and reads it back as TurnService would. */
function saveAndLoad(db: ConversationService, conversationId: string, reply: Awaited<ReturnType<typeof runTurn>>): LLMRequestMessage {
  const message = db.createMessage({
    conversationId,
    role: 'assistant',
    content: reply.content,
    toolCalls: reply.toolCalls.length > 0 ? JSON.stringify(reply.toolCalls) : undefined
  })
  db.saveReasoning(message.id, reply.reasoning)
  const stored = db.listMessages(conversationId).find((m) => m.id === message.id)!
  return toRequestMessages([stored], db.getSavedReasoning([message.id]))[0]
}

const prompt = (content: string, at = '2026-01-01T00:00:00.000Z'): LLMRequestMessage => ({ role: 'user', content, timestamp: at })

describe('reasoning replay across turns', () => {
  it('starts turn 2 byte for byte with turn 1\'s last request, reasoning on, over many rounds', async () => {
    const db = database()
    const chat = db.createConversation({ provider: 'openrouter', model: MODEL })
    const service = new LlmService({ getSettings: () => settingsWith(`${BASE_URL}/`), getSystemPrompt: () => 'system', timeZone: 'UTC' })
    // 14 tool rounds: text before some, none between others (they share a
    // place in the text), two calls in most, so 26 calls cross a budget notice.
    const TOOL_ROUNDS = 14
    provider.script = (request, options) => {
      if (request === 1 || request === 6) options.onChunk({ type: 'text', content: `Step ${request}. ` })
      if (request <= TOOL_ROUNDS) {
        options.onChunk({ type: 'tool_call', toolCall: { id: `r${request}a`, name: 'noop', arguments: { n: request } } })
        if (request % 4 !== 0) options.onChunk({ type: 'tool_call', toolCall: { id: `r${request}b`, name: 'noop', arguments: { n: request } } })
      } else {
        options.onChunk({ type: 'text', content: 'Done.' })
      }
      // Round 9 returns no reasoning at all; the rest do.
      if (request !== 9) options.onChunk({ type: 'reasoning_echo', reasoning: echoFor(request) })
    }

    const turn1 = await runTurn(service, { conversationId: chat.id, model: MODEL, provider: 'openrouter', messages: [prompt('research')] }, 't1')
    expect(provider.requests).toHaveLength(TOOL_ROUNDS + 1)
    expect(turn1.reasoning!.rounds.map((r) => r.round)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15])
    expect(turn1.reasoning!.rounds.at(-1)).toMatchObject({ round: 15, final: true })
    // Saved under the URL as providers use it.
    expect(turn1.reasoning!.baseUrl).toBe(BASE_URL)
    const lastLive = provider.requests[TOOL_ROUNDS]
    expect(JSON.stringify(lastLive)).toContain('tool_call_budget used=2')

    const reply = saveAndLoad(db, chat.id, turn1)
    expect(reply.savedReasoning).toBeDefined()

    // Turn 2: a no-tools follow-up.
    provider.script = (_request, options) => {
      options.onChunk({ type: 'text', content: 'Follow-up answer.' })
      options.onChunk({ type: 'reasoning_echo', reasoning: { reasoning_details: [{ type: 'reasoning.text', text: 'short', signature: 'sig-t2', index: 0 }] } })
    }
    const turn2Messages = [prompt('research'), reply, prompt('more', '2026-01-01T00:01:00.000Z')]
    const turn2 = await runTurn(service, { conversationId: chat.id, model: MODEL, provider: 'openrouter', messages: turn2Messages }, 't2')
    const turn2Request = provider.requests[TOOL_ROUNDS + 1]

    expect(JSON.stringify(turn2Request.slice(0, lastLive.length))).toBe(JSON.stringify(lastLive))
    // Then the closing text, with the last round's reasoning.
    expect(turn2Request[lastLive.length]).toEqual({ role: 'assistant', content: 'Done.', ...echoFor(15) })
    // The round that returned none is replayed without any, as it went live.
    const round9 = turn2Request.find((m) => m.tool_calls?.[0]?.id === 'r9a')!
    expect(Object.keys(round9)).toEqual(['role', 'content', 'tool_calls'])

    // Turn 3 starts with turn 2's request, then turn 2's reply and its reasoning.
    const reply2 = saveAndLoad(db, chat.id, turn2)
    await runTurn(service, {
      conversationId: chat.id,
      model: MODEL,
      provider: 'openrouter',
      messages: [...turn2Messages, reply2, prompt('again', '2026-01-01T00:02:00.000Z')]
    }, 't3')
    const turn3Request = provider.requests[TOOL_ROUNDS + 2]
    expect(JSON.stringify(turn3Request.slice(0, turn2Request.length))).toBe(JSON.stringify(turn2Request))
    expect(turn3Request[turn2Request.length]).toMatchObject({ role: 'assistant', content: 'Follow-up answer.', reasoning_details: [{ signature: 'sig-t2' }] })
  })

  it('leaves the blocks out for another model or server, and for replies saved without them', async () => {
    const saved: SavedReasoning = { v: 1, provider: 'openrouter', baseUrl: BASE_URL, model: MODEL, rounds: [{ round: 1, reasoning: echoFor(1) }, { round: 2, final: true, reasoning: echoFor(2) }] }
    const reply: LLMRequestMessage = {
      role: 'assistant',
      content: 'Done.',
      timestamp: '2026-01-01T00:00:01.000Z',
      toolCalls: [{ id: 'a', name: 'noop', arguments: {}, result: { ok: true }, round: 1, contentOffset: 0 }],
      savedReasoning: saved
    }
    provider.script = (_request, options) => options.onChunk({ type: 'text', content: 'ok' })
    const assistantFields = (request: LLMMessage[]) =>
      request.filter((m) => m.role === 'assistant').map((m) => Object.keys(m).filter((key) => key.startsWith('reasoning')))

    const cases: Array<{ baseUrl: string; model: string; withSaved: boolean; expected: string[][] }> = [
      { baseUrl: BASE_URL, model: MODEL, withSaved: true, expected: [['reasoning_details'], ['reasoning_details']] },
      { baseUrl: BASE_URL, model: 'openai/gpt-5', withSaved: true, expected: [[], []] },
      { baseUrl: 'https://other.example/v1', model: MODEL, withSaved: true, expected: [[], []] },
      { baseUrl: BASE_URL, model: MODEL, withSaved: false, expected: [[], []] }
    ]
    for (const [index, { baseUrl, model, withSaved, expected }] of cases.entries()) {
      const service = new LlmService({ getSettings: () => settingsWith(baseUrl), getSystemPrompt: () => 'system', timeZone: 'UTC' })
      await service.orchestrateStream({
        conversationId: 'c',
        model,
        provider: 'openrouter',
        messages: [prompt('q'), withSaved ? reply : { ...reply, savedReasoning: undefined }, prompt('more')]
      }, `m${index}`, { send: () => {} }, async (tc) => tc)
      expect(assistantFields(provider.requests[provider.requests.length - 1])).toEqual(expected)
    }

    // A different provider with the same URL and model doesn't match either.
    const custom = new LlmService({ getSettings: () => settingsWith(BASE_URL, 'custom'), getSystemPrompt: () => 'system', timeZone: 'UTC' })
    await custom.orchestrateStream({ conversationId: 'c', model: MODEL, provider: 'custom', messages: [prompt('q'), reply, prompt('more')] }, 'm-custom', { send: () => {} }, async (tc) => tc)
    expect(assistantFields(provider.requests[provider.requests.length - 1])).toEqual([[], []])
  })

  it('replays DeepSeek replies from their saved reasoning, and older ones from their thinking text', async () => {
    const service = new LlmService({ getSettings: () => settingsWith('https://api.deepseek.com', 'custom'), getSystemPrompt: () => 'system', timeZone: 'UTC' })
    const toolCalls: ToolCall[] = [
      { id: 'a', name: 'noop', arguments: {}, result: { ok: true }, round: 1, contentOffset: 0 },
      { id: 'b', name: 'noop', arguments: {}, result: { ok: true }, round: 2, contentOffset: 0 }
    ]
    const saved: SavedReasoning = {
      v: 1, provider: 'custom', baseUrl: 'https://api.deepseek.com', model: 'deepseek-reasoner',
      // Round 2 brought none.
      rounds: [{ round: 1, reasoning: { reasoning_content: 'saved first' } }, { round: 3, final: true, reasoning: { reasoning_content: 'saved closing' } }]
    }
    const thinking = 'old first\n\n---\n\nold second\n\n---\n\nold closing'
    provider.script = (_request, options) => options.onChunk({ type: 'text', content: 'ok' })

    for (const withSaved of [true, false]) {
      await service.orchestrateStream({
        conversationId: 'c',
        model: 'deepseek-reasoner',
        provider: 'custom',
        messages: [prompt('q'), { role: 'assistant', content: 'Done.', timestamp: '', toolCalls, thinking, ...(withSaved ? { savedReasoning: saved } : {}) }, prompt('more')]
      }, `d${String(withSaved)}`, { send: () => {} }, async (tc) => tc)
      const sent = provider.requests[provider.requests.length - 1].filter((m) => m.role === 'assistant').map((m) => m.reasoning_content)
      expect(sent).toEqual(withSaved ? ['saved first', '', 'saved closing'] : ['old first', 'old second', 'old closing'])
    }
  })

  it('keeps the reasoning of a round stopped while its tools ran, and saves none from a failed request', async () => {
    const service = new LlmService({ getSettings: () => settingsWith(BASE_URL), getSystemPrompt: () => 'system', timeZone: 'UTC' })
    provider.script = (_request, options) => {
      options.onChunk({ type: 'tool_call', toolCall: { id: 'a', name: 'noop', arguments: {} } })
      options.onChunk({ type: 'tool_call', toolCall: { id: 'b', name: 'noop', arguments: {} } })
      options.onChunk({ type: 'reasoning_echo', reasoning: echoFor(1) })
    }
    const saves: SavedReasoning[] = []
    await service.orchestrateStream(
      { conversationId: 'c', model: MODEL, provider: 'openrouter', messages: [prompt('q')] },
      'stop',
      { send: () => {}, saveReasoning: (saved) => saves.push(saved) },
      async (tc) => {
        service.cancelStream('stop')
        return { ...tc, result: { ok: true } }
      }
    )
    expect(saves).toEqual([{ v: 1, provider: 'openrouter', baseUrl: BASE_URL, model: MODEL, rounds: [{ round: 1, reasoning: echoFor(1) }] }])

    provider.script = (_request, options) => {
      options.onChunk({ type: 'reasoning_echo', reasoning: echoFor(1) })
      options.onChunk({ type: 'error', error: 'boom' })
    }
    const failed: SavedReasoning[] = []
    await service.orchestrateStream(
      { conversationId: 'c', model: MODEL, provider: 'openrouter', messages: [prompt('q')] },
      'fail',
      { send: () => {}, saveReasoning: (saved) => failed.push(saved) },
      async (tc) => tc
    )
    expect(failed).toEqual([])
  })

  it('sends a compaction the saved reasoning too, so it reads from the cache', async () => {
    const service = new LlmService({ getSettings: () => settingsWith(BASE_URL), getSystemPrompt: () => 'system', timeZone: 'UTC' })
    provider.script = (_request, options) => options.onChunk({ type: 'text', content: 'Summary.' })
    const saved: SavedReasoning = { v: 1, provider: 'openrouter', baseUrl: BASE_URL, model: MODEL, rounds: [{ round: 1, final: true, reasoning: echoFor(1) }] }
    await service.compactConversation({
      conversationId: 'c',
      model: MODEL,
      provider: 'openrouter',
      messages: [prompt('q'), { role: 'assistant', content: 'Answer.', timestamp: '', savedReasoning: saved }]
    }, 'compact')
    expect(provider.requests[0][2]).toEqual({ role: 'assistant', content: 'Answer.', ...echoFor(1) })
  })
})

describe('buildPastReplyMessages with saved reasoning', () => {
  it('matches rounds by number, keeps an unfinished call with its round, and skips a closing text that is blank', () => {
    const saved: SavedReasoning = {
      v: 1, provider: 'openrouter', baseUrl: BASE_URL, model: MODEL,
      rounds: [{ round: 1, reasoning: echoFor(1) }, { round: 2, reasoning: echoFor(2) }, { round: 3, final: true, reasoning: echoFor(3) }]
    }
    const messages = buildPastReplyMessages('   ', [
      { id: 'a', name: 'noop', arguments: {}, result: {}, round: 1, contentOffset: 0 },
      { id: 'b', name: 'noop', arguments: {}, result: {}, round: 2, contentOffset: 0 },
      // Stopped before it ran: no round recorded, so it joins round 2.
      { id: 'c', name: 'noop', arguments: {}, contentOffset: 0 }
    ], new Set(), savedReasoningLookup(saved))
    const assistants = messages.filter((m) => m.role === 'assistant')
    expect(assistants.map((m) => m.tool_calls?.map((tc) => tc.id))).toEqual([['a'], ['b', 'c']])
    expect(assistants.map((m) => m.reasoning_details)).toEqual([echoFor(1).reasoning_details, echoFor(2).reasoning_details])
    // Calls saved before rounds were recorded get none.
    const old = buildPastReplyMessages('Done.', [{ id: 'x', name: 'noop', arguments: {}, result: {} }], new Set(), savedReasoningLookup(saved))
    expect(old[0].reasoning_details).toBeUndefined()
    expect(old[2].reasoning_details).toEqual(echoFor(3).reasoning_details)
  })

  it('counts readable reasoning in estimates, but not signatures or encrypted blocks', () => {
    const base: LLMMessage = { role: 'assistant', content: 'x'.repeat(40) }
    const plain = estimateUsage([base], [], '').promptTokens
    const withText = estimateUsage([{ ...base, reasoning_details: [{ type: 'reasoning.text', text: 'y'.repeat(400), signature: 'z'.repeat(4000) }] }], [], '').promptTokens
    const withEncrypted = estimateUsage([{ ...base, reasoning_details: [{ type: 'reasoning.encrypted', data: 'z'.repeat(4000) }] }], [], '').promptTokens
    const withContent = estimateUsage([{ ...base, reasoning_content: 'y'.repeat(400) }], [], '').promptTokens
    expect(withText - plain).toBe(100)
    expect(withEncrypted).toBe(plain)
    expect(withContent - plain).toBe(100)
  })
})

describe('saved reasoning in the database', () => {
  const saved: SavedReasoning = { v: 1, provider: 'openrouter', baseUrl: BASE_URL, model: MODEL, rounds: [{ round: 1, final: true, reasoning: echoFor(3) }] }

  function chatWithReply(db: ConversationService) {
    const chat = db.createConversation({ provider: 'openrouter', model: MODEL })
    db.createMessage({ conversationId: chat.id, role: 'user', content: 'q' })
    const reply = db.createMessage({ conversationId: chat.id, role: 'assistant', content: 'Answer.', thinking: 'Thinking in round 3.' })
    db.saveReasoning(reply.id, saved)
    return { chat, reply }
  }

  it('reads back unchanged, and never reaches the page', () => {
    const db = database()
    const { chat, reply } = chatWithReply(db)
    expect(db.getSavedReasoning([reply.id]).get(reply.id)).toEqual(saved)
    expect(db.getSavedReasoning([])).toEqual(new Map())

    const listed = db.listMessages(chat.id)
    expect(JSON.stringify(listed)).not.toContain('sig-3')
    expect(JSON.stringify(db.exportMessages(chat.id))).not.toContain('sig-3')
    expect(Object.keys(listed[1])).not.toContain('replay')
  })

  it('is copied by forks, removed with its message, and counted in the chat\'s size', () => {
    const db = database()
    const { chat, reply } = chatWithReply(db)
    const before = db.listChatStorage().find((info) => info.conversationId === chat.id)!.textBytes

    const fork = db.forkConversation(chat.id, reply.id)
    const forkReply = db.listMessages(fork.id)[1]
    expect(db.getSavedReasoning([forkReply.id]).get(forkReply.id)).toEqual(saved)

    db.saveReasoning(reply.id, null)
    expect(db.getSavedReasoning([reply.id]).size).toBe(0)
    const after = db.listChatStorage().find((info) => info.conversationId === chat.id)!.textBytes
    expect(before - after).toBe(JSON.stringify(saved).length)

    db.deleteMessageBranch(fork.id, forkReply.id)
    expect(db.getSavedReasoning([forkReply.id]).size).toBe(0)
  })

  it('ignores a damaged or newer-format value, replaying the reply without reasoning', () => {
    expect(parseSavedReasoning('{not json')).toBeNull()
    expect(parseSavedReasoning(JSON.stringify({ ...saved, v: 2 }))).toBeNull()
    expect(parseSavedReasoning(JSON.stringify({ ...saved, provider: 'nope' }))).toBeNull()
    expect(parseSavedReasoning(JSON.stringify({ ...saved, rounds: [{ round: 1, reasoning: { reasoning_details: 'x' } }] }))).toBeNull()
    expect(parseSavedReasoning(JSON.stringify({ ...saved, rounds: [{ round: 1, reasoning: { surprise: 1 } }] }))).toBeNull()
    expect(parseSavedReasoning(JSON.stringify(saved))).toEqual(saved)
  })

  it('is left out of exports, and imported chats have none', async () => {
    const db = database()
    const { chat } = chatWithReply(db)
    const transfer = new ChatTransferService(db)
    const xml = transfer.exportConversation(chat.id, 'xml')
    const markdown = transfer.exportConversation(chat.id, 'markdown')
    for (const file of [xml, markdown]) {
      expect(file).not.toContain('sig-3')
      expect(file).not.toContain('reasoning_details')
    }
    // The readable thinking still goes out, as before.
    expect(xml).toContain('Thinking in round 3.')

    const imported = await transfer.importFromXml(xml)
    const ids = db.listMessages(imported.conversation.id).map((m) => m.id)
    expect(ids).toHaveLength(2)
    expect(db.getSavedReasoning(ids).size).toBe(0)
  })
})
