import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { MouseEvent } from 'react'

// Lucide's Copy and Check icons as markup, since code blocks are rendered from an
// HTML string. CSS shows one at a time based on the button's data-copied flag.
const ICON_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
const COPY_ICON = `<svg class="code-copy-icon" ${ICON_ATTRS}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`
const CHECK_ICON = `<svg class="code-copied-icon" ${ICON_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>`

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A code block with a copy button; `copyCodeOnClick` on an ancestor handles the button. */
export function codeBlockHtml(code: string): string {
  return '<div class="code-block">'
    + `<button type="button" class="code-copy-btn" title="Copy code" aria-label="Copy code">${COPY_ICON}${CHECK_ICON}</button>`
    + `<pre><code>${escapeHtml(code)}</code></pre>`
    + '</div>'
}

// GFM + line breaks; every code block gets a copy button.
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text }) {
      return codeBlockHtml(text)
    }
  }
})

/** Markdown to sanitized HTML. */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string)
}

export interface TextPart {
  kind: 'text' | 'code'
  text: string
}

/**
 * Split plain text into prose and its top-level fenced code blocks (``` or ~~~),
 * for messages shown as plain text rather than rendered Markdown.
 */
export function splitFencedCode(text: string): TextPart[] {
  if (!text.includes('```') && !text.includes('~~~')) return [{ kind: 'text', text }]

  const parts: TextPart[] = []
  let prose = ''
  const flushProse = () => {
    const trimmed = prose.replace(/^\n+|\n+$/g, '')
    if (trimmed) parts.push({ kind: 'text', text: trimmed })
    prose = ''
  }

  for (const token of marked.lexer(text)) {
    if (token.type === 'code' && token.codeBlockStyle !== 'indented') {
      flushProse()
      parts.push({ kind: 'code', text: token.text })
    } else {
      prose += token.raw
    }
  }
  flushProse()
  return parts
}

/** Delegated click handler for the copy buttons inside rendered code blocks. */
export function copyCodeOnClick(event: MouseEvent<HTMLElement>): void {
  const button = (event.target as Element).closest<HTMLButtonElement>('.code-copy-btn')
  const code = button?.closest('.code-block')?.querySelector('code')
  if (!button || !code) return

  navigator.clipboard.writeText(code.textContent ?? '').then(() => {
    button.dataset.copied = 'true'
    button.title = 'Copied!'
    setTimeout(() => {
      delete button.dataset.copied
      button.title = 'Copy code'
    }, 1500)
  }, () => {
    // Clipboard access can be denied by the environment/user permissions.
  })
}
