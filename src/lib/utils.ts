export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ')
}

// Created once: toLocaleDateString builds a new formatter on every call.
const monthDayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const monthDayYearFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

export function formatTimestamp(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  // Less than 1 minute
  if (diff < 60_000) return 'Just now'

  // Less than 1 hour
  if (diff < 3_600_000) {
    const mins = Math.floor(diff / 60_000)
    return `${mins}m ago`
  }

  // Less than 24 hours
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000)
    return `${hours}h ago`
  }

  // Same year
  if (date.getFullYear() === now.getFullYear()) {
    return monthDayFormat.format(date)
  }

  return monthDayYearFormat.format(date)
}

/** Size on disk for people: 0 B, 840 KB, 12.4 MB, 1.2 GB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}
