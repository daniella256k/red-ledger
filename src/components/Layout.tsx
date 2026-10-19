import { useCallback, useState } from 'react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { Sidebar } from './Sidebar'
import { ChatPanel } from './Chat/ChatPanel'
import { ContextPanel } from './Context/ContextPanel'

interface SidebarTriangleProps {
  direction: 'left' | 'right'
}

function SidebarTriangle({ direction }: SidebarTriangleProps) {
  if (direction === 'left') {
    return (
      <svg viewBox="0 0 8 10" aria-hidden="true" className="h-4 w-3 fill-current">
        <path d="M7.5 0.8L1 5l6.5 4.2V0.8Z" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 8 10" aria-hidden="true" className="h-4 w-3 fill-current">
      <path d="M0.5 0.8L7 5 0.5 9.2V0.8Z" />
    </svg>
  )
}

export function Layout() {
  const contextPanelRef = usePanelRef()
  const [isContextCollapsed, setIsContextCollapsed] = useState(false)

  const toggleContextPanel = useCallback(() => {
    const panel = contextPanelRef.current
    if (!panel) return

    if (panel.isCollapsed()) {
      panel.expand()
    } else {
      panel.collapse()
    }
  }, [contextPanelRef])

  const contextToggleLabel = isContextCollapsed ? 'Expand context sidebar' : 'Collapse context sidebar'

  return (
    <Group className="h-full w-full">
      {/* Left Sidebar */}
      <Panel defaultSize="20%" minSize="15%" maxSize="30%">
        <Sidebar />
      </Panel>

      <Separator className="pane-divider w-1" />

      {/* Center Chat */}
      <Panel defaultSize="50%" minSize="30%">
        <ChatPanel />
      </Panel>

      <Separator className="pane-divider relative w-1 overflow-visible">
        <button
          type="button"
          onClick={toggleContextPanel}
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          className="absolute left-0 top-1.5 z-20 flex h-8 w-8 -translate-x-[120%] items-center justify-center rounded-xs text-soft-charcoal/45 transition-colors hover:bg-paper-stack/65 hover:text-soft-charcoal/80 focus:outline-hidden focus-visible:bg-paper focus-visible:text-soft-charcoal focus-visible:ring-2 focus-visible:ring-rca-red/45"
          title={contextToggleLabel}
          aria-label={contextToggleLabel}
        >
          <SidebarTriangle direction={isContextCollapsed ? 'left' : 'right'} />
        </button>
      </Separator>

      {/* Right Context */}
      <Panel
        panelRef={contextPanelRef}
        defaultSize="30%"
        minSize="20%"
        maxSize="40%"
        collapsible
        collapsedSize="0%"
        className="overflow-hidden"
        onResize={() => setIsContextCollapsed(contextPanelRef.current?.isCollapsed() ?? false)}
      >
        <ContextPanel />
      </Panel>
    </Group>
  )
}
