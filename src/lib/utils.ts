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

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}
