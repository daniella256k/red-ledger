import { describe, it, expect } from 'vitest'
import { MAX_SVG_CHARS, checkSvgSource, drawingFileName, drawingTitle, svgDrawingOf } from '../svgDrawing'
import type { ToolCall } from '../../types'

const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><g><rect width="100" height="50" fill="#c00"/><text x="5" y="20">a &lt; b</text></g></svg>'

describe('checkSvgSource', () => {
  it('accepts a well-formed drawing', () => {
    expect(checkSvgSource(GOOD)).toBeNull()
  })

  it('accepts an XML declaration, doctype and comments around the root', () => {
    const source = `${String.fromCharCode(0xfeff)}<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<!-- a note -->\n${GOOD}\n<!-- end -->\n`
    expect(checkSvgSource(source)).toBeNull()
  })

  it('accepts width and height in place of a viewBox', () => {
    expect(checkSvgSource('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle r="5"/></svg>')).toBeNull()
  })

  it('accepts ">" inside attribute values, CDATA and style blocks', () => {
    const source = '<svg viewBox="0 0 10 10"><style><![CDATA[ a > b { fill: red } ]]></style><text data-note="1 > 0">x</text></svg>'
    expect(checkSvgSource(source)).toBeNull()
  })

  it('rejects text that is not an SVG document', () => {
    expect(checkSvgSource('```svg\n<svg viewBox="0 0 1 1"/>\n```')).toMatch(/root element is <svg/)
    expect(checkSvgSource('<div>hello</div>')).toMatch(/root element is <svg/)
  })

  it('asks for a viewBox when the root states no size', () => {
    expect(checkSvgSource('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toMatch(/viewBox/)
  })

  it('names the tag that is never closed', () => {
    expect(checkSvgSource('<svg viewBox="0 0 1 1"><g><rect/></svg>')).toMatch(/<\/svg> was found where <\/g> was expected/)
    expect(checkSvgSource('<svg viewBox="0 0 1 1"><g><rect/></g>')).toMatch(/<svg> is never closed/)
  })

  it('reports markup that was cut off', () => {
    expect(checkSvgSource('<svg viewBox="0 0 1 1"><path d="M0 0')).toMatch(/cut off inside a tag/)
  })

  it('reports a bare "<" in text', () => {
    expect(checkSvgSource('<svg viewBox="0 0 1 1"><text>a < b</text></svg>')).toMatch(/&lt;/)
  })

  it('reports content after the root element', () => {
    expect(checkSvgSource('<svg viewBox="0 0 1 1"/><svg viewBox="0 0 1 1"/>')).toMatch(/exactly one <svg>/)
    expect(checkSvgSource('<svg viewBox="0 0 1 1"></svg> Here is your drawing')).toMatch(/text after the closing/)
  })

  it('tells the model which elements are not drawn', () => {
    expect(checkSvgSource('<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>')).toMatch(/<script> is not supported/)
    expect(checkSvgSource('<svg viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>')).toMatch(/<foreignObject> is not supported/)
  })

  it('rejects a drawing over the size limit', () => {
    const source = `<svg viewBox="0 0 1 1">${'<g/>'.repeat(MAX_SVG_CHARS / 4)}</svg>`
    expect(checkSvgSource(source)).toMatch(/the limit is 200,000/)
  })
})

describe('drawing names', () => {
  it('gives a title, cut to one short line', () => {
    expect(drawingTitle('  Strike\n  timeline ')).toBe('Strike timeline')
    expect(drawingTitle(undefined)).toBe('Drawing')
    expect(drawingTitle('   ')).toBe('Drawing')
    expect(drawingTitle('x'.repeat(200))).toHaveLength(120)
  })

  it('makes a file name the OS accepts', () => {
    expect(drawingFileName('Wages: 1970/2020 <real>?')).toBe('Wages 1970 2020 real')
    expect(drawingFileName('report.')).toBe('report')
    expect(drawingFileName('???')).toBe('drawing')
  })
})

describe('svgDrawingOf', () => {
  const call = (extra: Partial<ToolCall>): ToolCall => ({
    id: 'c1',
    name: 'draw_svg',
    arguments: { title: 'Chart', svg: GOOD },
    ...extra
  })

  it('reads the drawing from a finished or still running call', () => {
    expect(svgDrawingOf(call({ result: { success: true } }))).toEqual({ title: 'Chart', svg: GOOD })
    expect(svgDrawingOf(call({}))).toEqual({ title: 'Chart', svg: GOOD })
  })

  it('has no drawing for a failed call, another tool, or missing source', () => {
    expect(svgDrawingOf(call({ result: { error: 'not well-formed', code: 'INVALID_INPUT' } }))).toBeNull()
    expect(svgDrawingOf(call({ name: 'write_file' }))).toBeNull()
    expect(svgDrawingOf(call({ arguments: { title: 'Chart' } }))).toBeNull()
    expect(svgDrawingOf(call({ arguments: { svg: 42 } }))).toBeNull()
  })
})
