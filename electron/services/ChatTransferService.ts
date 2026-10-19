import type {
  Attachment,
  Conversation,
  ImageAttachmentMimeType,
  Message,
  ProviderName
} from '../../src/types'
import type { ConversationService } from './ConversationService'
import { DEFAULT_MODEL, DEFAULT_PROVIDER, isProviderName } from '../../src/lib/providers'

export type ChatExportFormat = 'markdown' | 'xml'


const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<ImageAttachmentMimeType> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
])

export interface ImportedConversation {
  conversation: Conversation
  importedMessageCount: number
}

/**
 * Serializes/deserializes conversations to portable formats.
 * Markdown is human-readable (lossy for binary attachments).
 * XML preserves all message metadata for round-trip import.
 */
export class ChatTransferService {
  constructor(private readonly conversations: ConversationService) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  exportConversation(conversationId: string, format: ChatExportFormat): string {
    const conversation = this.conversations.getConversation(conversationId)
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`)
    }
    const messages = this.conversations.listMessages(conversationId)

    return format === 'xml'
      ? serializeXml(conversation, messages)
      : serializeMarkdown(conversation, messages)
  }

  /**
   * Suggested filename (without extension) derived from the conversation title.
   * Sanitized to be filesystem-safe across Windows/macOS/Linux.
   */
  buildSuggestedFilename(conversationId: string): string {
    const conversation = this.conversations.getConversation(conversationId)
    const rawTitle = conversation?.title?.trim() || 'chat'
    return sanitizeFilename(rawTitle)
  }

  importFromXml(xmlSource: string): ImportedConversation {
    const parsed = parseChatXml(xmlSource)

    const conversation = this.conversations.createConversation({
      title: parsed.conversation.title,
      model: parsed.conversation.model,
      provider: parsed.conversation.provider,
      isPinned: false,
      workspacePath: parsed.conversation.workspacePath
    })

    for (const message of parsed.messages) {
      this.conversations.createMessage({
        conversationId: conversation.id,
        role: message.role,
        content: message.content,
        attachments: message.attachments,
        thinking: message.thinking,
        toolCalls: message.toolCalls
      })
    }

    return {
      conversation,
      importedMessageCount: parsed.messages.length
    }
  }
}

// ─── Filename sanitization ───────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/g
const TRAILING_DOT_OR_SPACE = /[. ]+$/g

function sanitizeFilename(input: string): string {
  let cleaned = input.replace(INVALID_FILENAME_CHARS, '_').trim()
  cleaned = cleaned.replace(TRAILING_DOT_OR_SPACE, '')
  if (cleaned.length === 0) return 'chat'
  if (cleaned.length > 80) cleaned = cleaned.slice(0, 80).trim()
  return cleaned
}

// ─── Markdown serialization ──────────────────────────────────────────────────

function serializeMarkdown(conversation: Conversation, messages: Message[]): string {
  const lines: string[] = []

  lines.push(`# ${conversation.title}`)
  lines.push('')
  lines.push('| Field | Value |')
  lines.push('| --- | --- |')
  lines.push(`| Model | ${escapeMarkdownTableCell(conversation.model)} |`)
  lines.push(`| Provider | ${escapeMarkdownTableCell(conversation.provider)} |`)
  lines.push(`| Created | ${new Date(conversation.createdAt).toISOString()} |`)
  lines.push(`| Updated | ${new Date(conversation.updatedAt).toISOString()} |`)
  if (conversation.workspacePath) {
    lines.push(`| Workspace | ${escapeMarkdownTableCell(conversation.workspacePath)} |`)
  }
  lines.push(`| Messages | ${messages.length} |`)
  lines.push('')

  for (const message of messages) {
    lines.push('---')
    lines.push('')
    lines.push(`## ${roleHeading(message.role)} — ${message.timestamp}`)
    lines.push('')

    if (message.thinking && message.thinking.trim().length > 0) {
      lines.push('<details><summary>Thinking</summary>')
      lines.push('')
      lines.push('```')
      lines.push(message.thinking)
      lines.push('```')
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }

    lines.push(message.content || '_(empty message)_')
    lines.push('')

    if (message.attachments && message.attachments.length > 0) {
      lines.push('### Attachments')
      lines.push('')
      for (const attachment of message.attachments) {
        if (attachment.kind === 'image') {
          lines.push(`- **Image:** ${attachment.name} (${attachment.mimeType})`)
        } else {
          const content = attachment.content ?? ''
          lines.push(`- **File:** ${attachment.name}`)
          lines.push('')
          lines.push('  ```')
          lines.push(indent(content, '  '))
          lines.push('  ```')
        }
      }
      lines.push('')
    }

    if (message.toolCalls && message.toolCalls.trim().length > 0) {
      lines.push('<details><summary>Tool Calls</summary>')
      lines.push('')
      lines.push('```json')
      lines.push(prettifyJson(message.toolCalls))
      lines.push('```')
      lines.push('')
      lines.push('</details>')
      lines.push('')
    }
  }

  return lines.join('\n')
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function roleHeading(role: Message['role']): string {
  switch (role) {
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'system': return 'System'
  }
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((line) => prefix + line).join('\n')
}

function prettifyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

// ─── XML serialization ───────────────────────────────────────────────────────

const XML_VERSION = '1'

function serializeXml(conversation: Conversation, messages: Message[]): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(`<redLedgerChat version="${XML_VERSION}">`)
  lines.push('  <conversation>')
  lines.push(`    <title>${cdata(conversation.title)}</title>`)
  lines.push(`    <model>${cdata(conversation.model)}</model>`)
  lines.push(`    <provider>${cdata(conversation.provider)}</provider>`)
  lines.push(`    <createdAt>${conversation.createdAt}</createdAt>`)
  lines.push(`    <updatedAt>${conversation.updatedAt}</updatedAt>`)
  if (conversation.workspacePath) {
    lines.push(`    <workspacePath>${cdata(conversation.workspacePath)}</workspacePath>`)
  }
  lines.push('  </conversation>')
  lines.push('  <messages>')
  for (const message of messages) {
    lines.push(`    <message role="${escapeAttr(message.role)}" timestamp="${escapeAttr(message.timestamp)}" createdAt="${message.createdAt}">`)
    lines.push(`      <content>${cdata(message.content ?? '')}</content>`)
    if (message.thinking) {
      lines.push(`      <thinking>${cdata(message.thinking)}</thinking>`)
    }
    if (message.toolCalls) {
      lines.push(`      <toolCalls>${cdata(message.toolCalls)}</toolCalls>`)
    }
    if (message.attachments && message.attachments.length > 0) {
      lines.push('      <attachments>')
      for (const attachment of message.attachments) {
        if (attachment.kind === 'image') {
          lines.push(`        <attachment kind="image" name="${escapeAttr(attachment.name)}" mimeType="${escapeAttr(attachment.mimeType)}">`)
          lines.push(`          <dataUrl>${cdata(attachment.dataUrl)}</dataUrl>`)
          lines.push('        </attachment>')
        } else {
          lines.push(`        <attachment kind="text" name="${escapeAttr(attachment.name)}">`)
          lines.push(`          <content>${cdata(attachment.content)}</content>`)
          lines.push('        </attachment>')
        }
      }
      lines.push('      </attachments>')
    }
    lines.push('    </message>')
  }
  lines.push('  </messages>')
  lines.push('</redLedgerChat>')
  return lines.join('\n')
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function cdata(value: string): string {
  // CDATA blocks cannot contain ']]>'. Split + rejoin to keep payload intact.
  const safe = value.replace(/]]>/g, ']]]]><![CDATA[>')
  return `<![CDATA[${safe}]]>`
}

// ─── XML parsing ─────────────────────────────────────────────────────────────

interface ParsedChat {
  conversation: {
    title: string
    model: string
    provider: ProviderName
    workspacePath: string | null
  }
  messages: Array<{
    role: Message['role']
    content: string
    thinking?: string
    toolCalls?: string
    attachments?: Attachment[]
  }>
}

interface XmlNode {
  tag: string
  attrs: Record<string, string>
  /** Text content. CDATA contents are preserved verbatim (no trimming). */
  text: string
  children: XmlNode[]
}

function parseChatXml(source: string): ParsedChat {
  const root = parseXml(source)
  if (root.tag !== 'redLedgerChat') {
    throw new Error(`Unexpected root element: <${root.tag}>. Expected <redLedgerChat>.`)
  }

  const conversationNode = findChild(root, 'conversation')
  if (!conversationNode) {
    throw new Error('Missing <conversation> element')
  }

  const title = textOf(findChild(conversationNode, 'title'))?.trim() || 'Imported Chat'
  const model = textOf(findChild(conversationNode, 'model'))?.trim() || DEFAULT_MODEL
  const providerRaw = textOf(findChild(conversationNode, 'provider'))?.trim() || DEFAULT_PROVIDER
  const provider: ProviderName = isProviderName(providerRaw)
    ? providerRaw
    : DEFAULT_PROVIDER
  const workspacePathRaw = textOf(findChild(conversationNode, 'workspacePath'))
  const workspacePath = workspacePathRaw && workspacePathRaw.trim().length > 0
    ? workspacePathRaw.trim()
    : null

  const messagesNode = findChild(root, 'messages')
  const messageNodes = messagesNode ? findChildren(messagesNode, 'message') : []

  const messages = messageNodes.map((node) => parseMessageNode(node))

  return {
    conversation: { title, model, provider, workspacePath },
    messages
  }
}

function parseMessageNode(node: XmlNode): ParsedChat['messages'][number] {
  const roleRaw = node.attrs.role
  if (roleRaw !== 'user' && roleRaw !== 'assistant' && roleRaw !== 'system') {
    throw new Error(`Invalid message role: ${roleRaw}`)
  }

  const content = textOf(findChild(node, 'content')) ?? ''
  const thinking = textOf(findChild(node, 'thinking'))
  const toolCalls = textOf(findChild(node, 'toolCalls'))

  const attachmentsNode = findChild(node, 'attachments')
  const attachments = attachmentsNode
    ? findChildren(attachmentsNode, 'attachment')
        .map(parseAttachmentNode)
        .filter((a): a is Attachment => a !== null)
    : undefined

  return {
    role: roleRaw,
    content,
    thinking: thinking && thinking.length > 0 ? thinking : undefined,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    attachments: attachments && attachments.length > 0 ? attachments : undefined
  }
}

function parseAttachmentNode(node: XmlNode): Attachment | null {
  const name = node.attrs.name?.trim()
  if (!name) return null

  const kind = node.attrs.kind === 'image' ? 'image' : 'text'

  if (kind === 'image') {
    const mimeRaw = node.attrs.mimeType
    if (!mimeRaw || !SUPPORTED_IMAGE_MIME_TYPES.has(mimeRaw as ImageAttachmentMimeType)) {
      return null
    }
    const dataUrl = textOf(findChild(node, 'dataUrl'))
    if (!dataUrl) return null
    return {
      kind: 'image',
      name,
      mimeType: mimeRaw as ImageAttachmentMimeType,
      dataUrl
    }
  }

  const content = textOf(findChild(node, 'content')) ?? ''
  return {
    kind: 'text',
    name,
    content
  }
}

function findChild(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag)
}

function findChildren(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((c) => c.tag === tag)
}

function textOf(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined
  return node.text
}

// ─── Tiny XML parser ─────────────────────────────────────────────────────────
// Tailored to the format we emit above. Handles: XML declaration, comments,
// CDATA sections, self-closing tags, attributes, nested elements, basic entity
// decoding. Not a general-purpose XML parser.

function parseXml(source: string): XmlNode {
  let i = skipWhitespace(source, 0)

  if (source.startsWith('<?xml', i)) {
    const end = source.indexOf('?>', i)
    if (end === -1) throw new Error('Unterminated XML declaration')
    i = skipWhitespace(source, end + 2)
  }

  i = skipCommentsAndWhitespace(source, i)
  const result = parseElement(source, i)
  return result.node
}

function parseElement(source: string, start: number): { node: XmlNode; next: number } {
  if (source[start] !== '<') {
    throw new Error(`Expected '<' at position ${start}`)
  }

  let i = start + 1
  const tagEnd = findTagEnd(source, i)
  const headerRaw = source.slice(i, tagEnd)

  let header = headerRaw
  let selfClosing = false
  if (header.endsWith('/')) {
    selfClosing = true
    header = header.slice(0, -1).trimEnd()
  }

  const { tag, attrs } = parseTagHeader(header)
  i = tagEnd + 1

  if (selfClosing) {
    return { node: { tag, attrs, text: '', children: [] }, next: i }
  }

  const children: XmlNode[] = []
  let cdataBuf = ''
  let plainBuf = ''
  let sawCdata = false

  while (i < source.length) {
    const lt = source.indexOf('<', i)
    if (lt === -1) {
      throw new Error(`Unterminated element <${tag}>`)
    }

    if (lt > i) {
      plainBuf += decodeEntities(source.slice(i, lt))
    }

    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      if (end === -1) throw new Error('Unterminated CDATA section')
      cdataBuf += source.slice(lt + 9, end)
      sawCdata = true
      i = end + 3
      continue
    }

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      if (end === -1) throw new Error('Unterminated comment')
      i = end + 3
      continue
    }

    if (source[lt + 1] === '/') {
      const closeEnd = source.indexOf('>', lt + 2)
      if (closeEnd === -1) throw new Error(`Unterminated closing tag for <${tag}>`)
      const closingTag = source.slice(lt + 2, closeEnd).trim()
      if (closingTag !== tag) {
        throw new Error(`Mismatched closing tag: expected </${tag}>, got </${closingTag}>`)
      }
      // Prefer CDATA content (preserved verbatim) over loose text between tags,
      // which is usually just pretty-printing whitespace.
      const text = sawCdata ? cdataBuf : plainBuf.trim()
      return {
        node: { tag, attrs, text, children },
        next: closeEnd + 1
      }
    }

    const child = parseElement(source, lt)
    children.push(child.node)
    i = child.next
  }

  throw new Error(`Unterminated element <${tag}>`)
}

function findTagEnd(source: string, from: number): number {
  let inQuote: '"' | "'" | null = null
  for (let i = from; i < source.length; i++) {
    const ch = source[i]
    if (inQuote) {
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      continue
    }
    if (ch === '>') return i
  }
  throw new Error('Unterminated tag')
}

function parseTagHeader(header: string): { tag: string; attrs: Record<string, string> } {
  const trimmed = header.trim()
  let i = 0
  while (i < trimmed.length && !/\s/.test(trimmed[i])) i++
  const tag = trimmed.slice(0, i)
  const rest = trimmed.slice(i).trim()
  const attrs = parseAttributes(rest)
  return { tag, attrs }
}

function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  let i = 0
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++
    if (i >= input.length) break

    const nameStart = i
    while (i < input.length && input[i] !== '=' && !/\s/.test(input[i])) i++
    const name = input.slice(nameStart, i)
    if (!name) break

    while (i < input.length && /\s/.test(input[i])) i++
    if (input[i] !== '=') {
      attrs[name] = ''
      continue
    }
    i++
    while (i < input.length && /\s/.test(input[i])) i++

    const quote = input[i]
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Expected quoted attribute value for '${name}'`)
    }
    i++
    const valueStart = i
    while (i < input.length && input[i] !== quote) i++
    if (i >= input.length) throw new Error(`Unterminated attribute value for '${name}'`)
    attrs[name] = decodeEntities(input.slice(valueStart, i))
    i++
  }
  return attrs
}

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function skipWhitespace(source: string, from: number): number {
  let i = from
  while (i < source.length && /\s/.test(source[i])) i++
  return i
}

function skipCommentsAndWhitespace(source: string, from: number): number {
  let i = skipWhitespace(source, from)
  while (source.startsWith('<!--', i)) {
    const end = source.indexOf('-->', i + 4)
    if (end === -1) throw new Error('Unterminated comment')
    i = skipWhitespace(source, end + 3)
  }
  return i
}
