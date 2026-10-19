import { useEffect, useRef, useState } from 'react'
import { MessageSquare, FolderOpen, Settings } from 'lucide-react'
import { useUIStore } from '@/store'
import { ConversationList } from './ConversationList'
import { WorkspaceTree } from './WorkspaceTree'
import { SettingsPanel } from './SettingsPanel'
import { cn } from '@/lib/utils'

const SIDEBAR_TAB_TEXT_BREAKPOINT = 260
const SIDEBAR_NEW_CHAT_TEXT_BREAKPOINT = 165
const SIDEBAR_OPEN_FOLDER_TEXT_BREAKPOINT = SIDEBAR_NEW_CHAT_TEXT_BREAKPOINT + 20

const TABS = [
  { id: 'conversations' as const, icon: MessageSquare, label: 'Chats' },
  { id: 'workspace' as const, icon: FolderOpen, label: 'Workspace' },
  { id: 'settings' as const, icon: Settings, label: 'Settings' }
]

export function Sidebar() {
  const sidebarTab = useUIStore((s) => s.sidebarTab)
  const setSidebarTab = useUIStore((s) => s.setSidebarTab)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null)

  useEffect(() => {
    const node = sidebarRef.current
    if (!node) return

    const updateWidth = () => {
      setSidebarWidth(node.clientWidth)
    }

    updateWidth()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number') {
        setSidebarWidth(width)
      }
    })

    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const hideTabText = sidebarWidth !== null && sidebarWidth < SIDEBAR_TAB_TEXT_BREAKPOINT
  const hideNewChatText = sidebarWidth !== null && sidebarWidth < SIDEBAR_NEW_CHAT_TEXT_BREAKPOINT
  const hideOpenFolderText = sidebarWidth !== null && sidebarWidth < SIDEBAR_OPEN_FOLDER_TEXT_BREAKPOINT

  return (
    <div ref={sidebarRef} className="h-full flex flex-col bg-paper-stack">
      {/* Tab Bar */}
      <div className="bg-paper-stack/50 min-h-[42px] flex flex-col justify-end">
        <div className="flex items-stretch px-2 gap-1">
          {TABS.map(({ id, icon: Icon, label }) => {
            const isActive = sidebarTab === id
            return (
              <button
                key={id}
                onClick={() => setSidebarTab(id)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium rounded-t-lg transition-all border border-b-0',
                  isActive
                    ? 'bg-paper text-soft-charcoal border-weathered relative z-10 shadow-xs'
                    : 'bg-transparent text-soft-charcoal/50 border-transparent hover:text-soft-charcoal/80 hover:bg-paper/40'
                )}
                title={label}
              >
                <Icon size={14} strokeWidth={isActive ? 2.25 : 1.75} />
                {!hideTabText && <span className="whitespace-nowrap">{label}</span>}
              </button>
            )
          })}
        </div>
        {/* Tab edge - visually connects active tab to content */}
        <div className="h-px bg-weathered mx-2" />
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden bg-paper mx-2 mb-2 border-x border-b border-weathered rounded-b-lg">
        {sidebarTab === 'conversations' && <ConversationList compactNewChatButton={hideNewChatText} />}
        {sidebarTab === 'workspace' && <WorkspaceTree compactOpenFolderButton={hideOpenFolderText} />}
        {sidebarTab === 'settings' && <SettingsPanel />}
      </div>
    </div>
  )
}
