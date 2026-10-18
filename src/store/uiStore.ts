import { create } from 'zustand'
import type { Toast } from '@/types'
import { onNotify } from '@/lib/notify'

type SidebarTab = 'conversations' | 'workspace' | 'settings'

interface UIState {
  sidebarTab: SidebarTab
  workspacePath: string | null
  selectedFilePath: string | null
  /** Bumped when workspace files change on disk (e.g. after a write tool) so the tree reloads. */
  fileTreeVersion: number
  toasts: Toast[]

  setSidebarTab: (tab: SidebarTab) => void
  setWorkspacePath: (path: string | null) => void
  setSelectedFilePath: (path: string | null) => void
  bumpFileTree: () => void
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

let toastCounter = 0
const DEFAULT_TOAST_DURATION_MS = 4000

export const useUIStore = create<UIState>((set, get) => ({
  sidebarTab: 'conversations',
  workspacePath: null,
  selectedFilePath: null,
  fileTreeVersion: 0,
  toasts: [],

  setSidebarTab: (tab) => set({ sidebarTab: tab }),

  setWorkspacePath: (path) => set({ workspacePath: path }),

  setSelectedFilePath: (path) => set({ selectedFilePath: path }),

  bumpFileTree: () => set((state) => ({ fileTreeVersion: state.fileTreeVersion + 1 })),

  addToast: (toast) => {
    const id = `toast-${++toastCounter}`
    const duration = toast.duration ?? (toast.type === 'error' ? null : DEFAULT_TOAST_DURATION_MS)

    set((state) => ({
      toasts: [...state.toasts, { ...toast, id }]
    }))

    if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
      // Auto-dismiss non-error toasts unless explicitly made persistent.
      setTimeout(() => {
        get().removeToast(id)
      }, duration)
    }
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id)
    }))
}))

// Bridge: route notify() calls into the UI store's toast system
onNotify((toast) => useUIStore.getState().addToast(toast))
