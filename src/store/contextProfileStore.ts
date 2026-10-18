import { create } from 'zustand'
import type { ContextProfile } from '@/types'
import { formatError } from '@/lib/errors'
import { notify } from '@/lib/notify'

interface ContextProfileSnapshot {
  profiles: ContextProfile[]
  activeProfileId: string
}

interface ContextProfileState extends ContextProfileSnapshot {
  isLoaded: boolean

  loadProfiles: () => Promise<void>
  applyProfileState: (next: ContextProfileSnapshot) => void
}

/**
 * Context profiles, shared by the context panel (which edits them) and the
 * chat views (which show a chat's profile by name). The main process owns
 * the data; this mirrors its last answer.
 */
export const useContextProfileStore = create<ContextProfileState>((set) => ({
  profiles: [{ id: 'default', name: 'Default' }],
  activeProfileId: 'default',
  isLoaded: false,

  loadProfiles: async () => {
    if (!window.redLedger) return
    try {
      const state = await window.redLedger.listContextProfiles()
      set({ profiles: state.profiles, activeProfileId: state.activeProfileId, isLoaded: true })
    } catch (err) {
      notify({ type: 'error', message: formatError(err) })
    }
  },

  applyProfileState: (next) => {
    set({ profiles: next.profiles, activeProfileId: next.activeProfileId, isLoaded: true })
  }
}))

/**
 * Same fallback the main process uses when building the system prompt:
 * the chat's own profile if it still exists, otherwise the active one.
 */
export function resolveConversationProfile(
  profileId: string | null | undefined,
  state: ContextProfileSnapshot
): { profile: ContextProfile | null; isFallback: boolean } {
  const own = profileId ? state.profiles.find((profile) => profile.id === profileId) : undefined
  if (own) return { profile: own, isFallback: false }
  const active = state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null
  return { profile: active, isFallback: true }
}
