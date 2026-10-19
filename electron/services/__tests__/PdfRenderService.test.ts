import { describe, expect, it, vi } from 'vitest'

const loadedUrls: string[] = []

vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = { printToPDF: async () => Buffer.from('pdf') }
    async loadURL(url: string) { loadedUrls.push(url) }
    isDestroyed() { return false }
    destroy() {}
  }
}))

const { renderMarkdownToPdf } = await import('../PdfRenderService')

async function renderedBody(markdown: string): Promise<string> {
  loadedUrls.length = 0
  await renderMarkdownToPdf(markdown, { title: 'Test' })
  const html = decodeURIComponent(loadedUrls[0].replace('data:text/html;charset=utf-8,', ''))
  return html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>')).trim()
}

const SAMPLE = `# Heading

Some **bold**, *italic* and \`code\`.
Next line after a single break.

- tight item
- item with nested list
  - nested one
  - nested two

1. first
2. second

- loose item one

- loose item two

- [ ] open task
- [x] done task

| Name | Value |
| --- | ---: |
| a | 1 |
| b | 2 |

> quoted text

\`\`\`ts
const x = 1
\`\`\`

<div onclick="alert(1)">raw html</div>

Trailing paragraph.


`

describe('renderMarkdownToPdf', () => {
  it('renders GFM markdown to stable HTML', async () => {
    expect(await renderedBody(SAMPLE)).toMatchSnapshot()
  })

  it('drops raw HTML blocks', async () => {
    const body = await renderedBody('before\n\n<script>alert(1)</script>\n\nafter')
    expect(body).not.toContain('<script')
    expect(body).toContain('<p>before</p>')
    expect(body).toContain('<p>after</p>')
  })
})
