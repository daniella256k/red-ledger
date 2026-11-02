import { describe, expect, it } from 'vitest'
import { codeBlockHtml, splitFencedCode } from '../markdown'

describe('splitFencedCode', () => {
  it('leaves text without fences untouched', () => {
    const text = '  hello\n\n\tworld\n'
    expect(splitFencedCode(text)).toEqual([{ kind: 'text', text }])
  })

  it('splits prose around a fenced block', () => {
    const text = 'Try this:\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nThen run it.'
    expect(splitFencedCode(text)).toEqual([
      { kind: 'text', text: 'Try this:' },
      { kind: 'code', text: 'const a = 1\n\nconst b = 2' },
      { kind: 'text', text: 'Then run it.' }
    ])
  })

  it('handles tilde fences and back-to-back blocks', () => {
    expect(splitFencedCode('~~~\nx\n~~~\n```\ny\n```')).toEqual([
      { kind: 'code', text: 'x' },
      { kind: 'code', text: 'y' }
    ])
  })

  it('keeps indented code as prose', () => {
    const text = 'Intro ```\n\n    indented\n'
    expect(splitFencedCode(text)).toEqual([{ kind: 'text', text: 'Intro ```\n\n    indented' }])
  })
})

describe('codeBlockHtml', () => {
  it('escapes the code and adds a copy button', () => {
    const html = codeBlockHtml('<a href="x">&</a>')
    expect(html).toContain('<code>&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;</code>')
    expect(html).toContain('class="code-copy-btn"')
  })
})
