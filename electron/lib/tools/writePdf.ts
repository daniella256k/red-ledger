import { registerTool } from './registry'
import { toolDialog } from './toolDialog'
import { PathJailError } from '../../services/pathJail'
import { renderMarkdownToPdf } from '../../services/PdfRenderService'
import { optionalStringArg, requireObjectArgs, requireStringArg } from './args'

registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'write_pdf',
      description: 'Render markdown content into a PDF file in the user\'s workspace. Creates the file and any missing parent folders, or replaces the file if it exists. '
        + 'Replacing an existing file always asks the user first (in Strict Mode, creating a new file asks too). '
        + 'If the user declines, the result is an error with code USER_DENIED: do not retry, tell the user instead.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative .pdf path within the workspace (e.g. "docs/report.pdf")'
          },
          markdown: {
            type: 'string',
            description: 'Markdown content to render into the PDF'
          },
          title: {
            type: 'string',
            description: 'Optional document title for the rendered PDF'
          }
        },
        required: ['path', 'markdown']
      }
    }
  },
  execute: async (args, { win, workspace, signal }) => {
    const input = requireObjectArgs(args, 'write_pdf')
    const path = requireStringArg(input, 'path', 'write_pdf')
    const markdown = requireStringArg(input, 'markdown', 'write_pdf', {
      trim: false,
      allowEmpty: true
    })
    const title = optionalStringArg(input, 'title', 'write_pdf')

    if (!path.toLowerCase().endsWith('.pdf')) {
      throw new PathJailError('INVALID_INPUT', 'write_pdf requires a ".pdf" file path')
    }

    const pdfBuffer = await renderMarkdownToPdf(markdown, { title })
    await workspace.writeBinaryFile(toolDialog(win, signal), path, pdfBuffer)

    return { success: true, path, bytes: pdfBuffer.byteLength }
  }
})
