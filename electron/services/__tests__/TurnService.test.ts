import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationService } from '../ConversationService'
import { TurnService, type TurnServiceDeps } from '../TurnService'
import type { StreamSink } from '../LlmService'
import { sanitizeSettings } from '../SettingsService'
import { parseStoredToolCalls } from '../../../src/lib/storedToolCalls'
import type { ContextUsage, LLMRequest, ToolCall, TurnEvent } from '../../../src/types'

/** What a scripted reply can do: stream chunks, run tools, and wait to be stopped. */
interface ReplyContext {
  request: LLMRequest
  sink: StreamSink
  runTool: (toolCall: ToolCall) => Promise<ToolCall>
  /** Settles when the turn is stopped. */
  stopped: Promise<void>
}

type ReplyScript = (context: ReplyContext) => Promise<void>

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** Stands in for LlmService: each reply runs the script set for its chat. */
class FakeLlm {
  scripts = new Map<string, ReplyScript>()
  stops = new Map<string, () => void>()
  compactions: Array<{ summary: string; usage: ContextUsage } | null> = []
  requests: LLMRequest[] = []

  async orchestrateStream(request: LLMRequest, channel: string, sink: StreamSink, runTool: ReplyContext['runTool']) {
    this.requests.push(request)
    const stop = deferred()
    this.stops.set(channel, stop.resolve)
    const script = this.scripts.get(request.conversationId) ?? (async ({ sink: s }) => s.send({ type: 'text', content: 'ok' }))
    await script({ request, sink, runTool, stopped: stop.promise })
    sink.send({ type: 'done' })
  }

  async compactConversation(_request: LLMRequest, channel: string) {
    const stop = deferred()
    this.stops.set(channel, stop.resolve)
    return this.compactions.shift() ?? null
  }

  cancelStream(channel: string) {
    this.stops.get(channel)?.()
  }

  async generateTitle() {
    return 'Generated Title'
  }
}

const services: ConversationService[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.close()
})

function setup(options: { openWorkspace?: string | null; persistMs?: number } = {}) {
  const conversations = new ConversationService(':memory:')
  services.push(conversations)
  const llm = new FakeLlm()
  const events: TurnEvent[] = []
  const toolRunners: Array<{ replyMessageId: string; workspaceRoot: string | null }> = []
  const settings = sanitizeSettings(undefined)

  const turns = new TurnService({
    conversations,
    llm: llm as unknown as TurnServiceDeps['llm'],
    getSettings: () => settings,
    getOpenWorkspace: () => options.openWorkspace ?? null,
    createToolRunner: (replyMessageId, workspaceRoot) => {
      toolRunners.push({ replyMessageId, workspaceRoot })
      return async (toolCall) => ({ ...toolCall, result: { ok: true } })
    },
    getProfileName: () => 'Default',
    emit: (event) => events.push(event),
    timing: { updateMs: 1, persistMs: options.persistMs ?? 5, titleDelayMs: 0 }
  })

  return { conversations, llm, events, toolRunners, settings, turns }
}

describe('TurnService replies', () => {
  it('saves the prompt and an empty reply, then writes the reply as it streams', async () => {
    const { conversations, llm, events, turns } = setup()
    const chat = conversations.createConversation({ title: 'Chat' })
    llm.scripts.set(chat.id, async ({ sink }) => {
      sink.send({ type: 'thinking', content: 'Plan.' })
      sink.send({ type: 'text', content: 'Hello ' })
      sink.send({ type: 'text', content: 'world' })
      sink.send({ type: 'usage', usage: { promptTokens: 120, completionTokens: 4, contextLength: 8192, estimated: false } })
    })

    const branch = turns.start({ conversationId: chat.id, kind: 'send', content: 'Hi' })
    expect(branch.map((m) => [m.role, m.content])).toEqual([['user', 'Hi'], ['assistant', '']])
    expect(turns.isRunning(chat.id)).toBe(true)

    await turns.whenIdle(chat.id)

    const saved = conversations.listMessages(chat.id)
    expect(saved[1]).toMatchObject({ role: 'assistant', content: 'Hello world', thinking: 'Plan.' })
    expect(turns.isRunning(chat.id)).toBe(false)
    expect(events[0]).toMatchObject({ type: 'started', turn: { conversationId: chat.id, kind: 'reply', messageId: saved[1].id } })
    expect(events.at(-1)).toMatchObject({ type: 'finished', conversationId: chat.id, kind: 'reply' })

    // The request carried the chat so far, and the chat records what was sent and how much context it used.
    expect(llm.requests[0].messages.map((m) => m.content)).toEqual(['Hi'])
    const lastRequest = conversations.getConversation(chat.id)?.lastRequest
    expect(lastRequest).toMatchObject({ contextProfile: 'Default', usage: { promptTokens: 120, contextLength: 8192 } })
  })

  it('settles the provider, model and folder on the first message', async () => {
    const { conversations, settings, toolRunners, turns } = setup({ openWorkspace: '/work/a' })
    const chat = conversations.createConversation({})

    turns.start({ conversationId: chat.id, kind: 'send', content: 'Hi' })
    await turns.whenIdle(chat.id)

    const saved = conversations.getConversation(chat.id)!
    expect(saved.provider).toBe(settings.activeProvider)
    expect(saved.workspacePath).toBe('/work/a')
    expect(toolRunners[0].workspaceRoot).toBe('/work/a')
  })

  it("runs tools in the chat's own folder, not the one open now", async () => {
    const { conversations, toolRunners, turns } = setup({ openWorkspace: '/work/open' })
    const chat = conversations.createConversation({ workspacePath: '/work/own' })

    turns.start({ conversationId: chat.id, kind: 'send', content: 'Hi' })
    await turns.whenIdle(chat.id)

    expect(toolRunners[0].workspaceRoot).toBe('/work/own')
  })

  it('runs several chats at once, one turn per chat', async () => {
    const { conversations, llm, turns } = setup()
    const a = conversations.createConversation({ title: 'A' })
    const b = conversations.createConversation({ title: 'B' })
    const releaseA = deferred()
    const releaseB = deferred()
    llm.scripts.set(a.id, async ({ sink }) => { sink.send({ type: 'text', content: 'from A' }); await releaseA.promise })
    llm.scripts.set(b.id, async ({ sink }) => { sink.send({ type: 'text', content: 'from B' }); await releaseB.promise })

    turns.start({ conversationId: a.id, kind: 'send', content: 'a?' })
    turns.start({ conversationId: b.id, kind: 'send', content: 'b?' })
    expect(turns.listActive().map((t) => t.conversationId).sort()).toEqual([a.id, b.id].sort())
    expect(() => turns.start({ conversationId: a.id, kind: 'send', content: 'again' })).toThrow(/still working/)

    releaseB.resolve()
    await turns.whenIdle(b.id)
    expect(turns.isRunning(a.id)).toBe(true)
    releaseA.resolve()
    await turns.whenIdle(a.id)

    expect(conversations.listMessages(a.id).at(-1)?.content).toBe('from A')
    expect(conversations.listMessages(b.id).at(-1)?.content).toBe('from B')
  })

  it('lists running turns as far as they have got, for a page that reloads', async () => {
    const { conversations, llm, turns } = setup()
    const chat = conversations.createConversation({})
    const release = deferred()
    llm.scripts.set(chat.id, async ({ sink }) => { sink.send({ type: 'text', content: 'so far' }); await release.promise })

    turns.start({ conversationId: chat.id, kind: 'send', content: 'Hi' })
    await vi.waitFor(() => expect(turns.listActive()[0]?.content).toBe('so far'))

    release.resolve()
    await turns.whenIdle(chat.id)
    expect(turns.listActive()).toEqual([])
  })

  it('keeps what a stopped reply wrote, and drops one that wrote nothing', async () => {
    const { conversations, llm, turns } = setup()
    const partial = conversations.createConversation({})
    const empty = conversations.createConversation({})
    llm.scripts.set(partial.id, async ({ sink, stopped }) => { sink.send({ type: 'text', content: 'half' }); await stopped })
    llm.scripts.set(empty.id, async ({ stopped }) => { await stopped })

    turns.start({ conversationId: partial.id, kind: 'send', content: 'Hi' })
    turns.start({ conversationId: empty.id, kind: 'send', content: 'Hi' })
    turns.cancel(partial.id)
    turns.cancel(empty.id)
    await Promise.all([turns.whenIdle(partial.id), turns.whenIdle(empty.id)])

    expect(conversations.listMessages(partial.id).map((m) => m.content)).toEqual(['Hi', 'half'])
    expect(conversations.listMessages(empty.id).map((m) => m.content)).toEqual(['Hi'])
  })

  it('places each tool call where it happened in the text, and says when files changed', async () => {
    const { conversations, llm, events, turns } = setup()
    const chat = conversations.createConversation({})
    llm.scripts.set(chat.id, async ({ sink, runTool }) => {
      sink.send({ type: 'text', content: 'Writing it. ' })
      const call: ToolCall = { id: 'call-1', name: 'write_file', arguments: { path: 'a.md', content: 'x' } }
      sink.send({ type: 'tool_call', toolCall: call })
      sink.send({ type: 'tool_result', toolCall: await runTool(call) })
      sink.send({ type: 'text', content: 'Done.' })
    })

    turns.start({ conversationId: chat.id, kind: 'send', content: 'Write a.md' })
    await turns.whenIdle(chat.id)

    const reply = conversations.listMessages(chat.id).at(-1)!
    expect(reply.content).toBe('Writing it. Done.')
    expect(parseStoredToolCalls(reply.toolCalls)).toEqual([
      { id: 'call-1', name: 'write_file', arguments: { path: 'a.md', content: 'x' }, result: { ok: true }, contentOffset: 12 }
    ])
    expect(events.some((e) => e.type === 'filesChanged' && e.conversationId === chat.id)).toBe(true)
    // Updates carry tool calls only when they changed.
    const updates = events.filter((e) => e.type === 'update')
    expect(updates.some((e) => e.type === 'update' && e.toolCalls === undefined)).toBe(true)
    expect(updates.some((e) => e.type === 'update' && e.toolCalls?.length === 1)).toBe(true)
  })

  it('adds a retry beside the earlier reply, and an edit beside the original message', async () => {
    const { conversations, llm, turns } = setup()
    const chat = conversations.createConversation({})
    const question = conversations.createMessage({ conversationId: chat.id, role: 'user', content: 'q' })
    conversations.createMessage({ conversationId: chat.id, role: 'assistant', content: 'first answer' })
    llm.scripts.set(chat.id, async ({ sink }) => sink.send({ type: 'text', content: 'second answer' }))

    const retried = turns.start({ conversationId: chat.id, kind: 'retry', userMessageId: question.id })
    expect(retried.map((m) => m.content)).toEqual(['q', ''])
    await turns.whenIdle(chat.id)
    const afterRetry = conversations.listMessages(chat.id)
    expect(afterRetry.map((m) => m.content)).toEqual(['q', 'second answer'])
    expect(afterRetry[1].siblingIds).toHaveLength(2)
    // The retry sent the chat up to the question, without the earlier answer.
    expect(llm.requests[0].messages.map((m) => m.content)).toEqual(['q'])

    turns.start({ conversationId: chat.id, kind: 'edit', userMessageId: question.id, content: ' q, edited ' })
    await turns.whenIdle(chat.id)
    const afterEdit = conversations.listMessages(chat.id)
    expect(afterEdit[0]).toMatchObject({ content: 'q, edited' })
    expect(afterEdit[0].siblingIds).toHaveLength(2)
  })

  it('names a new chat from its first prompt', async () => {
    const { conversations, events, turns } = setup()
    const chat = conversations.createConversation({})

    turns.start({ conversationId: chat.id, kind: 'send', content: 'Plan a trip to Lisbon' })
    await turns.whenIdle(chat.id)

    await vi.waitFor(() => expect(conversations.getConversation(chat.id)?.title).toBe('Generated Title'))
    expect(events.some((e) => e.type === 'conversation' && e.conversation.title === 'Generated Title')).toBe(true)
  })

  it('reports a failed request and still finishes the turn', async () => {
    const { conversations, llm, events, turns } = setup()
    const chat = conversations.createConversation({})
    llm.scripts.set(chat.id, async () => { throw new Error('Provider exploded') })

    turns.start({ conversationId: chat.id, kind: 'send', content: 'Hi' })
    await turns.whenIdle(chat.id)

    expect(events).toContainEqual({ type: 'notice', conversationId: chat.id, level: 'error', message: 'Provider exploded' })
    expect(events.at(-1)).toMatchObject({ type: 'finished' })
    expect(conversations.listMessages(chat.id).map((m) => m.role)).toEqual(['user'])
  })

  it('saves what running replies wrote when the app quits, and starts nothing after', async () => {
    const { conversations, llm, turns } = setup({ persistMs: 60_000 })
    const chat = conversations.createConversation({})
    const release = deferred()
    llm.scripts.set(chat.id, async ({ sink }) => { sink.send({ type: 'text', content: 'unsaved so far' }); await release.promise })

    turns.start({ conversationId: chat.id, kind: 'send', content: 'Hi' })
    await vi.waitFor(() => expect(turns.listActive()[0]?.content).toBe('unsaved so far'))
    expect(conversations.listMessages(chat.id).at(-1)?.content).toBe('')

    turns.shutdown()
    expect(conversations.listMessages(chat.id).at(-1)?.content).toBe('unsaved so far')
    expect(() => turns.start({ conversationId: chat.id, kind: 'send', content: 'more' })).toThrow(/closing/)

    release.resolve()
    await turns.whenIdle(chat.id)
  })
})

describe('TurnService compaction', () => {
  it('has nothing to compact before the first reply', () => {
    const { conversations, turns } = setup()
    const chat = conversations.createConversation({})
    conversations.createMessage({ conversationId: chat.id, role: 'user', content: 'q' })

    expect(turns.compact(chat.id)).toBe('nothing_to_compact')
    expect(turns.isRunning(chat.id)).toBe(false)
  })

  it('adds the summary at the end of the chat and records the context it continues from', async () => {
    const { conversations, llm, events, turns } = setup()
    const chat = conversations.createConversation({})
    conversations.createMessage({ conversationId: chat.id, role: 'user', content: 'q' })
    conversations.createMessage({ conversationId: chat.id, role: 'assistant', content: 'a' })
    conversations.updateConversation(chat.id, {
      lastRequest: {
        sentAt: 't', provider: 'openai', model: 'm', temperature: null, maxTokens: null,
        reasoningEnabled: true, searchToolsEnabled: false, contextProfile: null
      }
    })
    llm.compactions.push({ summary: 'The summary.', usage: { promptTokens: 300, completionTokens: 0, contextLength: null, estimated: true } })

    expect(turns.compact(chat.id)).toBe('started')
    expect(turns.listActive()[0]).toMatchObject({ kind: 'compact', messageId: null })
    await turns.whenIdle(chat.id)

    const messages = conversations.listMessages(chat.id)
    expect(messages.at(-1)).toMatchObject({ role: 'system', content: 'The summary.' })
    expect(conversations.getConversation(chat.id)?.lastRequest?.usage?.promptTokens).toBe(300)
    expect(events.some((e) => e.type === 'notice' && e.level === 'success')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'finished', kind: 'compact' })
  })

  it('adds nothing when the compaction is stopped', async () => {
    const { conversations, turns } = setup()
    const chat = conversations.createConversation({})
    conversations.createMessage({ conversationId: chat.id, role: 'user', content: 'q' })
    conversations.createMessage({ conversationId: chat.id, role: 'assistant', content: 'a' })

    turns.compact(chat.id)
    turns.cancel(chat.id)
    await turns.whenIdle(chat.id)

    expect(conversations.listMessages(chat.id).map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('TurnService auto-compaction', () => {
  const summary = { summary: 'Summary of the long chat.', usage: { promptTokens: 900, completionTokens: 0, contextLength: 10_000, estimated: true } }

  /** A chat whose reply reports this much context use, with a summary ready to hand back. */
  function fullChat(used: { promptTokens: number; contextLength: number | null }) {
    const env = setup()
    const chat = env.conversations.createConversation({})
    env.llm.compactions.push(summary)
    env.llm.scripts.set(chat.id, async ({ sink }) => {
      sink.send({ type: 'text', content: 'A long answer.' })
      sink.send({ type: 'usage', usage: { promptTokens: used.promptTokens, completionTokens: 100, contextLength: used.contextLength, estimated: false } })
    })
    return { ...env, chat }
  }

  /** Waits for the reply, then for whatever turn followed it. */
  async function settle(turns: TurnService, conversationId: string) {
    await turns.whenIdle(conversationId)
    await turns.whenIdle(conversationId)
  }

  it('compacts right after a reply that fills most of the window', async () => {
    const { conversations, events, turns, chat } = fullChat({ promptTokens: 9_500, contextLength: 10_000 })

    turns.start({ conversationId: chat.id, kind: 'send', content: 'Keep going' })
    await settle(turns, chat.id)

    expect(conversations.listMessages(chat.id).map((m) => [m.role, m.content])).toEqual([
      ['user', 'Keep going'],
      ['assistant', 'A long answer.'],
      ['system', 'Summary of the long chat.']
    ])
    const kinds = events.flatMap((e) => (e.type === 'started' ? [e.turn.kind] : []))
    expect(kinds).toEqual(['reply', 'compact'])
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', level: 'info', message: expect.stringContaining('96%') }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'notice', level: 'success', message: expect.stringContaining('automatically') }))
    // The meter then shows the smaller context the chat continues from.
    expect(conversations.getConversation(chat.id)?.lastRequest?.usage?.promptTokens).toBe(900)
  })

  it('leaves a chat below the threshold alone', async () => {
    // A 10k window compacts at 7.5k (its reserve is a quarter of it); this reply used 7.1k.
    const { conversations, turns, chat } = fullChat({ promptTokens: 7_000, contextLength: 10_000 })

    turns.start({ conversationId: chat.id, kind: 'send', content: 'Hi' })
    await settle(turns, chat.id)

    expect(conversations.listMessages(chat.id).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('compacts at 80% of a large window, or earlier when fewer than 32k tokens are left', async () => {
    // 128k: 32k free comes first, at 96k (75%).
    const mid = fullChat({ promptTokens: 96_000, contextLength: 128_000 })
    mid.turns.start({ conversationId: mid.chat.id, kind: 'send', content: 'Hi' })
    await settle(mid.turns, mid.chat.id)
    expect(mid.conversations.listMessages(mid.chat.id).at(-1)?.role).toBe('system')

    // 1M: 80% comes first; 700k used is not yet there.
    const large = fullChat({ promptTokens: 700_000, contextLength: 1_000_000 })
    large.turns.start({ conversationId: large.chat.id, kind: 'send', content: 'Hi' })
    await settle(large.turns, large.chat.id)
    expect(large.conversations.listMessages(large.chat.id).at(-1)?.role).toBe('assistant')
  })

  it('does nothing when the setting is off or the window is unknown', async () => {
    const off = fullChat({ promptTokens: 9_900, contextLength: 10_000 })
    off.settings.autoCompact = false
    off.turns.start({ conversationId: off.chat.id, kind: 'send', content: 'Hi' })
    await settle(off.turns, off.chat.id)
    expect(off.conversations.listMessages(off.chat.id).map((m) => m.role)).toEqual(['user', 'assistant'])

    const unknown = fullChat({ promptTokens: 1_000_000, contextLength: null })
    unknown.turns.start({ conversationId: unknown.chat.id, kind: 'send', content: 'Hi' })
    await settle(unknown.turns, unknown.chat.id)
    expect(unknown.conversations.listMessages(unknown.chat.id).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('does not compact after a reply that was stopped', async () => {
    const { conversations, llm, turns, chat } = fullChat({ promptTokens: 9_900, contextLength: 10_000 })
    // A stopped reply gets no usage report from LlmService.
    llm.scripts.set(chat.id, async ({ sink, stopped }) => { sink.send({ type: 'text', content: 'partial' }); await stopped })

    turns.start({ conversationId: chat.id, kind: 'send', content: 'Hi' })
    turns.cancel(chat.id)
    await settle(turns, chat.id)

    expect(conversations.listMessages(chat.id).map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})
