import { useRef, useEffect } from 'react'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { useDarkMode } from '@/hooks/useDarkMode'
import { createRedLedgerTheme } from './redLedgerTheme'

interface EditorProps {
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  readOnly?: boolean
}

export function Editor({ value, onChange, placeholder, readOnly = false }: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const isDarkMode = useDarkMode()

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return

    const extensions = [
      createRedLedgerTheme(isDarkMode),
      markdown(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly)
    ]

    if (placeholder) {
      extensions.push(cmPlaceholder(placeholder))
    }

    if (onChange) {
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange(update.state.doc.toString())
          }
        })
      )
    }

    const state = EditorState.create({
      doc: value,
      extensions
    })

    const view = new EditorView({
      state,
      parent: containerRef.current
    })

    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Only run on mount/unmount — value syncing handled separately below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, isDarkMode])

  // Sync external value changes into the editor (avoid cursor jumps during typing)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const currentContent = view.state.doc.toString()
    if (currentContent !== value) {
      view.dispatch({
        changes: {
          from: 0,
          to: currentContent.length,
          insert: value
        }
      })
    }
  }, [value])

  return (
    <div ref={containerRef} className="h-full overflow-auto" />
  )
}
