import { useCallback, useMemo, useState } from 'react'
import type { DrawingFormat, ToolCall } from '@/types'
import type { SvgDrawing } from '@/lib/svgDrawing'
import { prepareSvg, renderSvgToPng } from '@/lib/svgRender'
import { formatError } from '@/lib/errors'
import { notify } from '@/lib/notify'
import { ToolCallRow } from './ToolCallRow'
import { SvgViewer } from './SvgViewer'

/** Tallest a drawing is shown in the chat, in pixels. */
const MAX_DISPLAY_HEIGHT = 520
/** Small drawings (icons) are enlarged until their longest side is this. */
const MIN_DISPLAY_SIDE = 220

type Action = 'copySvg' | 'copyImage' | 'saveSvg' | 'savePng'

interface SvgFigureProps {
  drawing: SvgDrawing
  /** The draw_svg call the drawing came from; shown as a plain tool line if it can't be drawn. */
  toolCall: ToolCall
}

/**
 * A drawing the model made with draw_svg: shown as an image on a light
 * backing (so it looks the same in dark mode as it does saved), with its
 * title and the copy and save actions underneath.
 */
export function SvgFigure({ drawing, toolCall }: SvgFigureProps) {
  const prepared = useMemo(() => prepareSvg(drawing.svg), [drawing.svg])
  const [done, setDone] = useState<Action | null>(null)
  const [busy, setBusy] = useState<Action | null>(null)
  const [isEnlarged, setIsEnlarged] = useState(false)
  const closeViewer = useCallback(() => setIsEnlarged(false), [])

  const run = useCallback(async (action: Action, work: () => Promise<boolean>) => {
    if (busy) return
    setBusy(action)
    try {
      if (await work()) {
        setDone(action)
        setTimeout(() => setDone((current) => (current === action ? null : current)), 1500)
      }
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    } finally {
      setBusy(null)
    }
  }, [busy])

  const save = useCallback(async (format: DrawingFormat, data: string | Uint8Array) => {
    const result = await window.redLedger.saveDrawing(drawing.title, format, data)
    if (result.ok) return true
    if (!result.canceled) notify({ type: 'error', message: `Could not save the drawing: ${result.error}` })
    return false
  }, [drawing.title])

  if (!prepared) {
    return (
      <div className="tool-burst">
        <ToolCallRow toolCall={toolCall} />
        <p className="svg-figure-note">This drawing could not be displayed.</p>
      </div>
    )
  }

  const { svg, width, height, dataUrl } = prepared
  const longest = Math.max(width, height)
  const scale = Math.min(Math.max(1, MIN_DISPLAY_SIDE / longest), MAX_DISPLAY_HEIGHT / height)

  const actions: Array<{ id: Action; label: string; doneLabel: string; work: () => Promise<boolean> }> = [
    {
      id: 'copySvg',
      label: 'Copy SVG',
      doneLabel: 'Copied',
      work: async () => {
        await navigator.clipboard.writeText(svg)
        return true
      }
    },
    {
      id: 'copyImage',
      label: 'Copy image',
      doneLabel: 'Copied',
      work: async () => {
        // The promise form keeps the clipboard write inside the click's permission.
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderSvgToPng(prepared) })])
        return true
      }
    },
    {
      id: 'saveSvg',
      label: 'Save SVG',
      doneLabel: 'Saved',
      work: () => save('svg', svg)
    },
    {
      id: 'savePng',
      label: 'Save PNG',
      doneLabel: 'Saved',
      work: async () => save('png', new Uint8Array(await (await renderSvgToPng(prepared)).arrayBuffer()))
    }
  ]

  return (
    <figure className="svg-figure">
      <div className="svg-figure-canvas">
        <button
          type="button"
          className="svg-figure-open"
          onClick={() => setIsEnlarged(true)}
          title="Click to enlarge"
          aria-label={`Enlarge ${drawing.title}`}
        >
          <img
            src={dataUrl}
            alt={drawing.title}
            draggable={false}
            style={{ width: `${Math.round(width * scale)}px`, aspectRatio: `${width} / ${height}` }}
          />
        </button>
      </div>
      {isEnlarged && <SvgViewer prepared={prepared} title={drawing.title} onClose={closeViewer} />}
      <figcaption className="svg-figure-bar">
        <span className="svg-figure-title" title={drawing.title}>{drawing.title}</span>
        {actions.map(({ id, label, doneLabel, work }) => (
          <button
            key={id}
            type="button"
            className="svg-figure-action"
            disabled={busy !== null}
            onClick={() => { void run(id, work) }}
          >
            {done === id ? doneLabel : label}
          </button>
        ))}
      </figcaption>
    </figure>
  )
}
