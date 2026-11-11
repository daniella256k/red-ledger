import type { ToolCall } from '../types'

/**
 * The draw_svg tool's shared, pure parts: checking what the model sent (main
 * process) and reading a drawing back out of a stored tool call (the chat).
 * No DOM here, so both sides and the tests can use it.
 */

export const DRAW_SVG_TOOL = 'draw_svg'
/** Longest SVG source one call may send. */
export const MAX_SVG_CHARS = 200_000

export interface SvgDrawing {
  title: string
  svg: string
}

const DEFAULT_TITLE = 'Drawing'
/** Elements the chat removes before drawing; the model is told, so it doesn't rely on them. */
const UNSUPPORTED_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed'])

/** The source without a leading BOM, XML declaration, doctype or comments. */
function stripProlog(source: string): string {
  let text = (source.charCodeAt(0) === 0xfeff ? source.slice(1) : source).trimStart()
  for (;;) {
    const next = text
      .replace(/^<\?xml[\s\S]*?\?>/i, '')
      .replace(/^<!DOCTYPE[^>]*>/i, '')
      .replace(/^<!--[\s\S]*?-->/, '')
      .trimStart()
    if (next === text) return text
    text = next
  }
}

/**
 * Walk the markup's tags and report the first structural mistake (a tag never
 * closed, closed in the wrong order, or cut off), or an element the chat won't
 * draw. Not a full XML parser: just enough to tell the model what to fix.
 */
function findMarkupProblem(text: string): string | null {
  const stack: string[] = []
  let roots = 0
  /** Where the root element ended, once it has. */
  let rootEnd = -1
  let i = 0

  while (i < text.length) {
    const open = text.indexOf('<', i)
    if (open === -1) break

    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4)
      if (end === -1) return 'a comment is never closed (missing "-->")'
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9)
      if (end === -1) return 'a CDATA section is never closed (missing "]]>")'
      i = end + 3
      continue
    }
    if (text.startsWith('<?', open) || text.startsWith('<!', open)) {
      const end = text.indexOf('>', open)
      if (end === -1) return 'the markup is cut off inside a declaration'
      i = end + 1
      continue
    }

    // Find this tag's closing ">", skipping any inside quoted attribute values.
    let end = open + 1
    let quote = ''
    for (; end < text.length; end += 1) {
      const ch = text[end]
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === '\'') {
        quote = ch
      } else if (ch === '>') {
        break
      }
    }
    if (end >= text.length) return 'the markup is cut off inside a tag (a ">" or closing quote is missing)'

    const inner = text.slice(open + 1, end)
    const isClosing = inner.startsWith('/')
    const name = /^\/?([A-Za-z_][\w:.-]*)/.exec(inner)?.[1]
    if (!name) return `"<${inner.slice(0, 20)}" is not a valid tag (write a literal "<" in text as "&lt;")`

    if (isClosing) {
      const expected = stack.pop()
      if (expected === undefined) return `</${name}> closes a tag that was never opened`
      if (expected !== name) return `</${name}> was found where </${expected}> was expected`
    } else {
      if (UNSUPPORTED_ELEMENTS.has(name.toLowerCase())) {
        return `<${name}> is not supported: drawings are shown as static images, with no scripts or embedded HTML`
      }
      if (stack.length === 0) roots += 1
      if (roots > 1) return 'there is content after the closing </svg> tag: send exactly one <svg> element'
      if (!inner.trimEnd().endsWith('/')) stack.push(name)
    }
    if (stack.length === 0) rootEnd = end + 1
    i = end + 1
  }

  if (stack.length > 0) return `<${stack[stack.length - 1]}> is never closed`
  if (rootEnd !== -1 && text.slice(rootEnd).replace(/<!--[\s\S]*?-->/g, '').trim()) {
    return 'there is text after the closing </svg> tag'
  }
  return null
}

/**
 * Why this SVG source can't be shown, as a sentence the model can act on;
 * null when it looks drawable.
 */
export function checkSvgSource(source: string): string | null {
  if (source.length > MAX_SVG_CHARS) {
    return `The SVG is ${source.length.toLocaleString('en-US')} characters; the limit is ${MAX_SVG_CHARS.toLocaleString('en-US')}. Simplify the drawing.`
  }

  const text = stripProlog(source)
  if (!/^<svg[\s>/]/i.test(text)) {
    return 'The "svg" argument must be a complete SVG document whose root element is <svg ...>, with no Markdown code fence or other text around it.'
  }

  const rootTag = /^<svg(?:"[^"]*"|'[^']*'|[^>"'])*>/i.exec(text)?.[0] ?? ''
  const hasViewBox = /\sviewBox\s*=/i.test(rootTag)
  const hasSize = /\swidth\s*=/i.test(rootTag) && /\sheight\s*=/i.test(rootTag)
  if (!hasViewBox && !hasSize) {
    return 'The <svg> element needs a viewBox (e.g. viewBox="0 0 800 600") so the drawing has a size.'
  }

  const problem = findMarkupProblem(text)
  return problem ? `The SVG is not well-formed: ${problem}.` : null
}

/** The drawing's title, cut to one short line. */
export function drawingTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!title) return DEFAULT_TITLE
  return title.length > 120 ? `${title.slice(0, 117)}...` : title
}

/** A safe file name (no extension) for saving the drawing. */
export function drawingFileName(title: string): string {
  const name = title
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim()
  return name || 'drawing'
}

/**
 * The drawing a tool call carries, when it is a draw_svg call that did not
 * fail. A call still running counts: its arguments are already complete.
 */
export function svgDrawingOf(toolCall: ToolCall): SvgDrawing | null {
  if (toolCall.name !== DRAW_SVG_TOOL) return null
  const svg = toolCall.arguments?.svg
  if (typeof svg !== 'string' || !svg.trim()) return null
  const result = toolCall.result
  if (result && typeof result === 'object' && 'error' in result) return null
  return { title: drawingTitle(toolCall.arguments.title), svg }
}
