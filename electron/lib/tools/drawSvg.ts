import { registerTool } from './registry'
import { PathJailError } from '../../services/pathJail'
import { optionalStringArg, requireObjectArgs, requireStringArg } from './args'
import { DRAW_SVG_TOOL, MAX_SVG_CHARS, checkSvgSource, drawingTitle } from '../../../src/lib/svgDrawing'

/**
 * Shows an SVG drawing in the chat. Nothing is written to disk and nothing
 * comes back for the model to look at: the drawing lives in the call's own
 * arguments, which the chat renders (sanitized, as an image) and which later
 * turns replay, so the model can revise its own source.
 */
registerTool({
  definition: {
    type: 'function',
    function: {
      name: DRAW_SVG_TOOL,
      description: 'Draw a picture, diagram or chart for the user as SVG. The drawing appears in the chat at the point of the call, where the user can copy or save it as SVG or PNG. '
        + 'You will not see the rendered result, so lay it out carefully: keep everything inside the viewBox and leave room for text. '
        + 'It is shown as a static image on a light background: no scripts, no <foreignObject>, no external images, fonts or stylesheets (use generic font families such as sans-serif, serif, monospace). '
        + 'Do not repeat the SVG source in your reply. To change a drawing, call this again with the complete updated SVG. '
        + 'If the result is an error, fix the markup and call again.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short title for the drawing (shown as its caption and used as the file name when saved)'
          },
          svg: {
            type: 'string',
            description: `Complete SVG document: a single <svg xmlns="http://www.w3.org/2000/svg" viewBox="..."> root element, well-formed XML, at most ${MAX_SVG_CHARS.toLocaleString('en-US')} characters`
          }
        },
        required: ['svg']
      }
    }
  },
  execute: async (args) => {
    const input = requireObjectArgs(args, DRAW_SVG_TOOL)
    const svg = requireStringArg(input, 'svg', DRAW_SVG_TOOL)
    const title = optionalStringArg(input, 'title', DRAW_SVG_TOOL, { allowEmpty: true })

    const problem = checkSvgSource(svg)
    if (problem) throw new PathJailError('INVALID_INPUT', problem)

    return { success: true, shown_to_user: true, title: drawingTitle(title) }
  }
})
