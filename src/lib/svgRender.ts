import DOMPurify from 'dompurify'

/**
 * Turning a model's SVG source into something safe to show, copy and save.
 * Needs a DOM, so it lives apart from the pure helpers in svgDrawing.ts.
 *
 * The drawing is sanitized (no scripts, event handlers, embedded HTML or
 * references outside the file) and then shown through an <img>, where an SVG
 * can't run code, load anything or reach the app's styles. The same sanitized
 * source is what gets copied and saved, since a saved SVG opened in a browser
 * would otherwise run whatever it carried.
 */

export interface PreparedSvg {
  /** Sanitized, well-formed SVG with explicit width and height. */
  svg: string
  width: number
  height: number
  /** The drawing as an image URL for <img src>. */
  dataUrl: string
}

/** Size a browser gives an SVG that states none. */
const FALLBACK_WIDTH = 300
const FALLBACK_HEIGHT = 150
/** Longest side of a rendered PNG, in pixels. */
const PNG_MAX_SIDE = 4096
/** A PNG's longest side is at least this (when the drawing allows), so small drawings stay sharp. */
const PNG_TARGET_SIDE = 1600

const UNIT_PX: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, em: 16, rem: 16 }

/** An SVG length in pixels; null for a percentage or anything unreadable. */
function lengthPx(value: string | null): number | null {
  const match = /^\s*(\d*\.?\d+)\s*([a-z]*)\s*$/i.exec(value ?? '')
  if (!match) return null
  const factor = UNIT_PX[match[2].toLowerCase()]
  if (factor === undefined) return null
  const px = Number.parseFloat(match[1]) * factor
  return Number.isFinite(px) && px > 0 ? px : null
}

function viewBoxSize(value: string | null): { width: number; height: number } | null {
  const parts = (value ?? '').trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  return parts[2] > 0 && parts[3] > 0 ? { width: parts[2], height: parts[3] } : null
}

/** A reference that stays inside the file: a fragment, or an embedded raster image. */
function isLocalReference(value: string): boolean {
  const ref = value.trim()
  return ref.startsWith('#') || /^data:image\/(?:png|jpe?g|gif|webp);/i.test(ref)
}

/** CSS with @import rules and url() references outside the file removed. */
function stripExternalCss(css: string): string {
  return css
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/url\(\s*(?!["']?\s*(?:#|data:image\/(?:png|jpe?g|gif|webp);))[^)]*\)/gi, 'none')
}

/** Remove everything that points outside the drawing, so a saved copy never loads or links anywhere. */
function stripExternalReferences(root: Element): void {
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (element.localName === 'style' && element.textContent) {
      element.textContent = stripExternalCss(element.textContent)
    }
    for (const attr of Array.from(element.attributes)) {
      if (attr.localName === 'href' || attr.localName === 'src') {
        if (!isLocalReference(attr.value)) element.removeAttributeNode(attr)
      } else if (/url\(|@import/i.test(attr.value)) {
        attr.value = stripExternalCss(attr.value)
      }
    }
  }
}

/**
 * Sanitize a drawing and give it a definite size. Null when nothing drawable
 * is left (no <svg> element, or a size of zero).
 */
export function prepareSvg(source: string): PreparedSvg | null {
  let root: Element | null
  try {
    const body = DOMPurify.sanitize(source, {
      USE_PROFILES: { svg: true, svgFilters: true },
      // <use> is left out of the profile because it can pull in other files;
      // references outside the drawing are removed below, so it is safe here
      // and drawings that repeat a shape rely on it.
      ADD_TAGS: ['use'],
      RETURN_DOM: true
    })
    root = (body as HTMLElement).querySelector('svg')
  } catch {
    return null
  }
  if (!root) return null

  stripExternalReferences(root)

  const viewBox = viewBoxSize(root.getAttribute('viewBox'))
  let width = lengthPx(root.getAttribute('width'))
  let height = lengthPx(root.getAttribute('height'))
  if (!width && !height) {
    width = viewBox?.width ?? FALLBACK_WIDTH
    height = viewBox?.height ?? FALLBACK_HEIGHT
  } else if (!height) {
    height = viewBox ? (width! * viewBox.height) / viewBox.width : FALLBACK_HEIGHT
  } else if (!width) {
    width = viewBox ? (height * viewBox.width) / viewBox.height : FALLBACK_WIDTH
  }
  if (!width || !height) return null

  // An <img> needs the size stated on the element, and a viewBox to scale by.
  root.setAttribute('width', String(Math.round(width * 100) / 100))
  root.setAttribute('height', String(Math.round(height * 100) / 100))
  if (!viewBox) root.setAttribute('viewBox', `0 0 ${width} ${height}`)

  // XMLSerializer writes well-formed XML with the SVG namespace declared,
  // which an SVG used as an image or opened as a file must have.
  const svg = new XMLSerializer().serializeToString(root)
  return {
    svg,
    width,
    height,
    dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }
}

/** The drawing as a PNG on a white background, at a size that stays sharp. */
export async function renderSvgToPng(prepared: PreparedSvg): Promise<Blob> {
  const longest = Math.max(prepared.width, prepared.height)
  const scale = Math.min(Math.max(2, PNG_TARGET_SIDE / longest), PNG_MAX_SIDE / longest)

  const image = new Image()
  image.src = prepared.dataUrl
  await image.decode()

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(prepared.width * scale))
  canvas.height = Math.max(1, Math.round(prepared.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not render the drawing')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Could not render the drawing'))
    }, 'image/png')
  })
}
