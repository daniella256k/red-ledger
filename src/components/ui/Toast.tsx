import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { useAutoAnimate } from '@formkit/auto-animate/react'
import { useUIStore } from '@/store'
import { cn } from '@/lib/utils'
import type { Toast } from '@/types'

const ICONS = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info
}

const ALERT_CLASSES = {
  success: 'alert-success',
  error: 'alert-error',
  warning: 'alert-warning',
  info: 'alert-info'
}

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useUIStore((s) => s.removeToast)
  const Icon = ICONS[toast.type]

  return (
    <div className={cn('alert shadow-lg text-sm py-2 px-3', ALERT_CLASSES[toast.type])}>
      <Icon size={16} />
      <span className="flex-1">{toast.message}</span>
      <button
        onClick={() => removeToast(toast.id)}
        className="btn btn-ghost btn-xs text-current hover:bg-base-content/20 hover:border-transparent hover:shadow-none"
      >
        <X size={14} />
      </button>
    </div>
  )
}

export function Toaster() {
  const toasts = useUIStore((s) => s.toasts)
  const [animateParent] = useAutoAnimate()

  return (
    <div ref={animateParent} className="fixed bottom-4 right-4 z-50 space-y-2 max-w-sm">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
