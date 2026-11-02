import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

interface ThemePalette {
  background: string
  foreground: string
  cursor: string
  selection: string
  activeLine: string
  gutterBackground: string
  gutterForeground: string
  gutterBorder: string
  foldBackground: string
  foldBorder: string
  placeholder: string
  heading: string
  link: string
  url: string
  monospace: string
  quote: string
  list: string
  comment: string
  processingInstruction: string
}

const LIGHT_PALETTE: ThemePalette = {
  background: '#FDFCF8',
  foreground: '#2C2C2C',
  cursor: '#DB1E1E',
  selection: 'rgba(219, 30, 30, 0.15)',
  activeLine: 'rgba(245, 241, 232, 0.5)',
  gutterBackground: '#F4F1EA',
  gutterForeground: '#2C2C2C80',
  gutterBorder: '#E5E0D5',
  foldBackground: '#F4F1EA',
  foldBorder: '#E5E0D5',
  placeholder: '#2C2C2C40',
  heading: '#2C2C2C',
  link: '#DB1E1E',
  url: '#5D737E',
  monospace: '#8B4513',
  quote: '#2C2C2C99',
  list: '#DB1E1E',
  comment: '#2C2C2C50',
  processingInstruction: '#5D737E'
}

const DARK_PALETTE: ThemePalette = {
  background: '#1F1A19',
  foreground: '#F1E7DE',
  cursor: '#E24848',
  selection: 'rgba(226, 72, 72, 0.22)',
  activeLine: 'rgba(65, 52, 49, 0.45)',
  gutterBackground: '#272120',
  gutterForeground: '#F1E7DE80',
  gutterBorder: '#453B38',
  foldBackground: '#352E2C',
  foldBorder: '#4D423F',
  placeholder: '#F1E7DE55',
  heading: '#F6ECE3',
  link: '#EE7E7E',
  url: '#8AB7C7',
  monospace: '#D0A37B',
  quote: '#F1E7DE99',
  list: '#EE7E7E',
  comment: '#F1E7DE66',
  processingInstruction: '#8AB7C7'
}

function buildTheme(palette: ThemePalette) {
  return EditorView.theme({
    '&': {
      backgroundColor: palette.background,
      color: palette.foreground,
      fontSize: '13px'
    },
    '.cm-content': {
      caretColor: palette.cursor,
      fontFamily: "'JetBrains Mono', 'Menlo', monospace",
      // JetBrains Mono otherwise draws <!-- and --> as arrows.
      fontVariantLigatures: 'none',
      padding: '8px 0'
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: palette.cursor,
      borderLeftWidth: '2px'
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: palette.selection
    },
    '.cm-activeLine': {
      backgroundColor: palette.activeLine
    },
    '.cm-gutters': {
      backgroundColor: palette.gutterBackground,
      color: palette.gutterForeground,
      border: 'none',
      borderRight: `1px solid ${palette.gutterBorder}`
    },
    '.cm-activeLineGutter': {
      backgroundColor: palette.activeLine
    },
    '.cm-foldPlaceholder': {
      backgroundColor: palette.foldBackground,
      color: palette.gutterForeground,
      border: `1px solid ${palette.foldBorder}`
    },
    '.cm-placeholder': {
      color: palette.placeholder,
      fontStyle: 'italic'
    },
    '.cm-line': {
      padding: '0 8px'
    }
  })
}

function buildHighlighting(palette: ThemePalette) {
  return HighlightStyle.define([
    { tag: tags.heading, fontWeight: 'bold', color: palette.heading },
    { tag: tags.heading1, fontSize: '1.3em' },
    { tag: tags.heading2, fontSize: '1.15em' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.link, color: palette.link, textDecoration: 'underline' },
    { tag: tags.url, color: palette.url },
    { tag: tags.monospace, fontFamily: "'JetBrains Mono', monospace", color: palette.monospace },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.quote, color: palette.quote, fontStyle: 'italic' },
    { tag: tags.list, color: palette.list },
    { tag: tags.comment, color: palette.comment },
    { tag: tags.processingInstruction, color: palette.processingInstruction }
  ])
}

export function createRedLedgerTheme(isDarkMode: boolean) {
  const palette = isDarkMode ? DARK_PALETTE : LIGHT_PALETTE
  return [buildTheme(palette), syntaxHighlighting(buildHighlighting(palette))]
}
