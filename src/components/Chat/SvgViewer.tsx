import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { PreparedSvg } from '@/lib/svgRender'

/** Space kept clear around the drawing: sides, and top/bottom (room for the caption). */
const MARGIN_X = 24
const MARGIN_Y = 44
/** How far one click zooms in, and the furthest the wheel goes, relative to fitting the window. */
const CLICK_ZOOM = 2.5
const MAX_ZOOM = 12
/** A press that moves less than this many pixels is a click, not a drag. */
const DRAG_THRESHOLD = 4

interface View {
  /** 1 = the drawing fitted to the window. */
  zoom: number
  /** The drawing's centre, as an offset from the window's centre. */
  x: number
  y: number
}

const FITTED: View = { zoom: 1, x: 0, y: 0 }

interface SvgViewerProps {
  prepared: PreparedSvg
  title: string
  onClose: () => void
}

/**
 * A drawing enlarged to fill the window. Click a spot to zoom in on it and
 * click again to fit the window; the wheel zooms around the pointer and
 * dragging moves a zoomed drawing. Escape, the close button or a click
 * outside the drawing closes it. An SVG is redrawn at each size, so it stays
 * sharp however far in.
 */
export function SvgViewer({ prepared, title, onClose }: SvgViewerProps) {
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [view, setView] = useState<View>(FITTED)
  const [dragging, setDragging] = useState(false)
  const press = useRef<{ x: number; y: number; viewX: number; viewY: number; moved: boolean } | null>(null)

  useEffect(() => {
    const onResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  const roomX = Math.max(1, windowSize.width - MARGIN_X * 2)
  const roomY = Math.max(1, windowSize.height - MARGIN_Y * 2)
  const fit = Math.min(roomX / prepared.width, roomY / prepared.height)
  const fitWidth = prepared.width * fit
  const fitHeight = prepared.height * fit
  const centerX = windowSize.width / 2
  const centerY = windowSize.height / 2

  /** Keep a zoomed drawing from being moved off the window; one that fits stays centred. */
  const clamp = (next: View): View => {
    const zoom = Math.min(MAX_ZOOM, Math.max(1, next.zoom))
    const limitX = Math.max(0, (fitWidth * zoom - roomX) / 2)
    const limitY = Math.max(0, (fitHeight * zoom - roomY) / 2)
    return {
      zoom,
      x: Math.min(limitX, Math.max(-limitX, next.x)),
      y: Math.min(limitY, Math.max(-limitY, next.y))
    }
  }

  // Clamped on every render too, so resizing the window can't strand the drawing.
  const current = clamp(view)

  /** Zoom to a level, keeping the point under the pointer where it is. */
  const zoomAt = (zoom: number, pointerX: number, pointerY: number) => {
    const target = Math.min(MAX_ZOOM, Math.max(1, zoom))
    const ratio = target / current.zoom
    setView(clamp({
      zoom: target,
      x: pointerX - centerX - (pointerX - centerX - current.x) * ratio,
      y: pointerY - centerY - (pointerY - centerY - current.y) * ratio
    }))
  }

  const width = fitWidth * current.zoom
  const height = fitHeight * current.zoom
  const zoomed = current.zoom > 1.001

  return createPortal(
    <div
      className="svg-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      onWheel={(event) => zoomAt(current.zoom * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY)}
    >
      <img
        src={prepared.dataUrl}
        alt={title}
        draggable={false}
        style={{
          left: `${centerX + current.x - width / 2}px`,
          top: `${centerY + current.y - height / 2}px`,
          width: `${width}px`,
          height: `${height}px`,
          cursor: dragging ? 'grabbing' : zoomed ? 'zoom-out' : 'zoom-in'
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          press.current = { x: event.clientX, y: event.clientY, viewX: current.x, viewY: current.y, moved: false }
        }}
        onPointerMove={(event) => {
          const start = press.current
          if (!start) return
          const dx = event.clientX - start.x
          const dy = event.clientY - start.y
          if (!start.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
          start.moved = true
          if (!zoomed) return
          setDragging(true)
          setView(clamp({ zoom: current.zoom, x: start.viewX + dx, y: start.viewY + dy }))
        }}
        onPointerUp={(event) => {
          const start = press.current
          press.current = null
          setDragging(false)
          if (!start || start.moved) return
          if (zoomed) setView(FITTED)
          else zoomAt(CLICK_ZOOM, event.clientX, event.clientY)
        }}
        onPointerCancel={() => {
          press.current = null
          setDragging(false)
        }}
      />
      <button type="button" className="svg-viewer-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
        <X size={18} />
      </button>
      <p className="svg-viewer-caption">
        {title} | {zoomed ? 'Drag to move, click to fit the window' : 'Click to zoom in'} | Scroll to zoom | Esc to close
      </p>
    </div>,
    document.body
  )
}
