import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { formatError } from '@/lib/errors'
import { useContextProfileStore, useConversationStore, useUIStore } from '@/store'
import { ContextEditor } from './ContextEditor'

const CONTEXT_TYPES = [
  { type: 'system' as const, title: 'System Prompt', description: 'Core behavioral instructions' },
  { type: 'user' as const, title: 'User Context', description: 'Personal info, preferences' },
  { type: 'org' as const, title: 'Org Context', description: 'Organization mission, terms, style' }
]

const HIDE_PROFILE_LABEL_BREAKPOINT = 340
const COMPACT_PROFILE_SELECT_BREAKPOINT = 310
const EXTRA_COMPACT_PROFILE_SELECT_BREAKPOINT = 275

export function ContextPanel() {
  const profiles = useContextProfileStore((s) => s.profiles)
  const activeProfileId = useContextProfileStore((s) => s.activeProfileId)
  const applyProfileState = useContextProfileStore((s) => s.applyProfileState)
  const profileState = { profiles, activeProfileId }
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  // The profile the chat on screen uses; for the unsaved New Chat draft, the
  // one it was left set to.
  const conversationProfileId = useConversationStore((s) =>
    s.activeConversationId === null
      ? s.draft?.profileId ?? null
      : s.conversations.find((c) => c.id === s.activeConversationId)?.profileId ?? null
  )
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(() => Boolean(window.redLedger))
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false)
  const [isSyncingChatProfile, startChatProfileSync] = useTransition()
  // The inline name form under the header, for a new profile or renaming the selected one.
  const [profileFormMode, setProfileFormMode] = useState<'create' | 'rename' | null>(null)
  const [profileNameDraft, setProfileNameDraft] = useState('')
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerWidth, setHeaderWidth] = useState<number | null>(null)

  useEffect(() => {
    if (!window.redLedger) return

    let cancelled = false
    window.redLedger.listContextProfiles()
      .then((state) => {
        if (cancelled) return
        applyProfileState(state)
      })
      .catch((err) => {
        if (cancelled) return
        useUIStore.getState().addToast({
          type: 'error',
          message: formatError(err)
        })
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingProfiles(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [applyProfileState])

  // Switching chats restores the profile that chat was started with, so the
  // selector and editors show the context its system prompt is built from.
  // Returning to the New Chat draft restores the profile it was set to.
  // Chats from before per-chat profiles (null), or whose profile was deleted,
  // keep whatever is selected; the main process falls back the same way.
  useEffect(() => {
    if (!window.redLedger || isLoadingProfiles || !conversationProfileId) return
    const { profiles: knownProfiles, activeProfileId: currentProfileId } = useContextProfileStore.getState()
    if (conversationProfileId === currentProfileId) return
    if (!knownProfiles.some((profile) => profile.id === conversationProfileId)) return

    let cancelled = false
    startChatProfileSync(async () => {
      try {
        const next = await window.redLedger.setActiveContextProfile(conversationProfileId)
        if (!cancelled) applyProfileState(next)
      } catch (err) {
        useUIStore.getState().addToast({
          type: 'error',
          message: formatError(err)
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [activeConversationId, conversationProfileId, isLoadingProfiles, applyProfileState])

  const handleProfileChange = useCallback(async (profileId: string) => {
    if (!window.redLedger) return
    if (profileId === profileState.activeProfileId) return

    try {
      setIsUpdatingProfile(true)
      const next = await window.redLedger.setActiveContextProfile(profileId)
      applyProfileState(next)
      // Picking a profile while in a chat moves that chat to it; in the New
      // Chat view it sets the draft's profile, which new chats start with.
      if (activeConversationId) {
        await useConversationStore.getState().setConversationProfile(activeConversationId, profileId)
      } else {
        useConversationStore.getState().setDraftProfile(profileId)
      }
    } catch (err) {
      useUIStore.getState().addToast({
        type: 'error',
        message: formatError(err)
      })
    } finally {
      setIsUpdatingProfile(false)
    }
  }, [activeConversationId, applyProfileState, profileState.activeProfileId])

  const resetProfileForm = useCallback(() => {
    setProfileFormMode(null)
    setProfileNameDraft('')
  }, [])

  // A rename is for the profile that was selected when it started.
  const [formProfileId, setFormProfileId] = useState(activeProfileId)
  if (formProfileId !== activeProfileId) {
    setFormProfileId(activeProfileId)
    if (profileFormMode === 'rename') setProfileFormMode(null)
  }

  const handleSubmitProfileForm = useCallback(async () => {
    if (!window.redLedger || !profileFormMode) return

    const trimmed = profileNameDraft.trim()
    if (!trimmed) {
      useUIStore.getState().addToast({
        type: 'warning',
        message: 'Enter a profile name'
      })
      return
    }

    try {
      setIsUpdatingProfile(true)
      const next = profileFormMode === 'rename'
        ? await window.redLedger.renameContextProfile(activeProfileId, trimmed)
        : await window.redLedger.createContextProfile(trimmed)
      applyProfileState(next)
      resetProfileForm()
    } catch (err) {
      useUIStore.getState().addToast({
        type: 'error',
        message: formatError(err)
      })
    } finally {
      setIsUpdatingProfile(false)
    }
  }, [activeProfileId, applyProfileState, profileFormMode, profileNameDraft, resetProfileForm])

  const profileControlsDisabled = isLoadingProfiles || isUpdatingProfile || isSyncingChatProfile
  const activeProfile = profileState.profiles.find((profile) => profile.id === profileState.activeProfileId) || null
  const canDeleteActiveProfile = activeProfile?.id !== 'default'
  const showProfileLabel = headerWidth === null || headerWidth >= HIDE_PROFILE_LABEL_BREAKPOINT

  let selectWidthClass = 'w-[130px]'
  if (headerWidth !== null && headerWidth < EXTRA_COMPACT_PROFILE_SELECT_BREAKPOINT) {
    selectWidthClass = 'w-[88px]'
  } else if (headerWidth !== null && headerWidth < COMPACT_PROFILE_SELECT_BREAKPOINT) {
    selectWidthClass = 'w-[102px]'
  }

  useEffect(() => {
    const node = headerRef.current
    if (!node) return

    const update = () => setHeaderWidth(node.clientWidth)
    update()

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (typeof width === 'number') {
        setHeaderWidth(width)
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const handleDeleteActiveProfile = useCallback(async () => {
    if (!window.redLedger || !activeProfile) return
    if (activeProfile.id === 'default') {
      useUIStore.getState().addToast({
        type: 'warning',
        message: 'The Default profile cannot be deleted'
      })
      return
    }

    const confirmed = await window.redLedger.showConfirmDialog({
      title: 'Delete Profile',
      message: `Delete "${activeProfile.name}" profile?`,
      detail: 'This action cannot be undone.'
    })
    if (!confirmed) return

    try {
      setIsUpdatingProfile(true)
      const next = await window.redLedger.deleteContextProfile(activeProfile.id)
      applyProfileState(next)
      resetProfileForm()
    } catch (err) {
      useUIStore.getState().addToast({
        type: 'error',
        message: formatError(err)
      })
    } finally {
      setIsUpdatingProfile(false)
    }
  }, [activeProfile, applyProfileState, resetProfileForm])

  return (
    <div className="h-full flex flex-col bg-paper">
      <div ref={headerRef} className="h-[42px] px-4 border-b border-weathered bg-paper-stack/50 flex items-center gap-2 overflow-hidden">
        <h2 className="text-xs font-semibold text-soft-charcoal/70 uppercase tracking-wider shrink-0">Context</h2>
        <div className="ml-auto flex items-center gap-1.5 min-w-0 shrink-0">
          {showProfileLabel && (
            <span className="text-[10px] font-semibold text-soft-charcoal/45 uppercase tracking-wider shrink-0">
              Profile
            </span>
          )}
          <select
            value={profileState.activeProfileId}
            disabled={profileControlsDisabled}
            onChange={(e) => handleProfileChange(e.target.value)}
            className={`select select-xs select-bordered ${selectWidthClass} bg-base-100 text-xs shrink-0`}
            title="Select context profile"
          >
            {profileState.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={profileControlsDisabled || !activeProfile}
            onClick={() => {
              if (profileFormMode === 'rename') {
                resetProfileForm()
              } else {
                setProfileFormMode('rename')
                setProfileNameDraft(activeProfile?.name ?? '')
              }
            }}
            className="btn btn-ghost btn-xs text-soft-charcoal/55 hover:text-soft-charcoal"
            title="Rename selected profile"
            aria-label="Rename selected profile"
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            disabled={profileControlsDisabled}
            onClick={() => {
              if (profileFormMode === 'create') {
                resetProfileForm()
              } else {
                setProfileFormMode('create')
                setProfileNameDraft('')
              }
            }}
            className="btn btn-ghost btn-xs text-soft-charcoal/55 hover:text-soft-charcoal"
            title="Create profile"
            aria-label="Create profile"
          >
            <Plus size={13} />
          </button>
          <button
            type="button"
            disabled={profileControlsDisabled || !canDeleteActiveProfile}
            onClick={() => void handleDeleteActiveProfile()}
            className="btn btn-ghost btn-xs text-soft-charcoal/55 hover:text-error disabled:hover:text-soft-charcoal/55"
            title={canDeleteActiveProfile ? 'Delete selected profile' : 'Default profile cannot be deleted'}
            aria-label="Delete selected profile"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {profileFormMode && (
        <div className="px-4 py-2 border-b border-weathered/70 bg-paper-stack/30 flex items-center gap-1.5">
          <input
            type="text"
            value={profileNameDraft}
            onChange={(e) => setProfileNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleSubmitProfileForm()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                resetProfileForm()
              }
            }}
            disabled={isUpdatingProfile}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            placeholder={profileFormMode === 'rename' ? 'Profile name' : 'New profile name'}
            maxLength={48}
            className="input input-xs input-bordered flex-1 min-w-0 bg-base-100 text-xs"
          />
          <button
            type="button"
            onClick={() => void handleSubmitProfileForm()}
            disabled={isUpdatingProfile}
            className="btn btn-xs btn-primary px-2"
            title={profileFormMode === 'rename' ? 'Save name' : 'Create profile'}
            aria-label={profileFormMode === 'rename' ? 'Save profile name' : 'Create profile'}
          >
            <Check size={12} />
          </button>
          <button
            type="button"
            onClick={resetProfileForm}
            disabled={isUpdatingProfile}
            className="btn btn-xs btn-ghost px-2"
            title="Cancel"
            aria-label={profileFormMode === 'rename' ? 'Cancel rename' : 'Cancel profile creation'}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col p-3 gap-3 min-h-0">
        {CONTEXT_TYPES.map(({ type, title, description }) => (
          <ContextEditor
            key={`${profileState.activeProfileId}:${type}`}
            profileId={profileState.activeProfileId}
            type={type}
            title={title}
            description={description}
          />
        ))}
      </div>
    </div>
  )
}
