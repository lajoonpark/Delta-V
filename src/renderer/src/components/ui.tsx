import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { X } from 'lucide-react'

/**
 * Small shared UI primitives — buttons, toggles, segmented controls,
 * selects, fields and a modal shell. Everything is keyboard accessible
 * and styled for both light and dark themes.
 */

// ── Buttons ────────────────────────────────────────────────────────────────

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  active?: boolean
  danger?: boolean
}

export function IconButton({
  label,
  active,
  danger,
  className = '',
  ...rest
}: IconButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={[
        'no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
        'text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-800',
        'dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
        active
          ? 'bg-zinc-200/80 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100'
          : '',
        danger ? 'hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400' : '',
        className
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): React.ReactElement {
  const variants: Record<ButtonVariant, string> = {
    primary:
      'bg-accent text-zinc-950 shadow-tile hover:bg-accent-soft active:bg-accent-dim font-medium',
    secondary:
      'border border-zinc-300 bg-white text-zinc-700 shadow-tile hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800',
    ghost:
      'text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800',
    danger:
      'border border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/70'
  }
  return (
    <button
      type="button"
      className={[
        'no-drag inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px]',
        'transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        className
      ].join(' ')}
      {...rest}
    >
      {children}
    </button>
  )
}

// ── Toggle switch ──────────────────────────────────────────────────────────

export function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange(checked: boolean): void
  label?: string
  disabled?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'no-drag relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
        'disabled:pointer-events-none disabled:opacity-40',
        checked ? 'bg-accent' : 'bg-zinc-300 dark:bg-zinc-700'
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        ].join(' ')}
      />
    </button>
  )
}

// ── Segmented control ──────────────────────────────────────────────────────

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md'
}: {
  value: T
  options: { value: T; label: string; icon?: ReactNode }[]
  onChange(value: T): void
  size?: 'sm' | 'md'
}): React.ReactElement {
  return (
    <div
      className="no-drag inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
      role="tablist"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={[
            'inline-flex items-center gap-1.5 rounded-[7px] font-medium transition-all',
            size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-3 text-xs',
            value === opt.value
              ? 'bg-white text-zinc-900 shadow-tile dark:bg-zinc-700 dark:text-white'
              : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
          ].join(' ')}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ── Inputs ─────────────────────────────────────────────────────────────────

export const inputClass =
  'no-drag selectable h-8 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-[13px] text-zinc-800 ' +
  'placeholder:text-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 ' +
  'dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-accent'

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): React.ReactElement {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-300">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-400">{hint}</span>}
    </label>
  )
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.ReactElement {
  const { className = '', ...rest } = props
  return (
    <textarea
      className={`${inputClass} h-auto min-h-[64px] py-2 font-mono text-xs leading-relaxed ${className}`}
      {...rest}
    />
  )
}

// ── Modal shell ────────────────────────────────────────────────────────────

export function Modal({
  onClose,
  children,
  width = 'max-w-2xl',
  labelledBy
}: {
  onClose(): void
  children: ReactNode
  width?: string
  labelledBy?: string
}): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/40 px-4 pt-[12vh] backdrop-blur-[2px] dark:bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`animate-pop-in w-full ${width} overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-overlay dark:border-zinc-800 dark:bg-zinc-900`}
      >
        {children}
      </div>
    </div>
  )
}

export function ModalHeader({
  title,
  subtitle,
  onClose,
  id
}: {
  title: string
  subtitle?: string
  onClose(): void
  id?: string
}): React.ReactElement {
  return (
    <div className="flex items-start justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
      <div className="min-w-0">
        <h2 id={id} className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      <IconButton label="Close" onClick={onClose}>
        <X size={15} />
      </IconButton>
    </div>
  )
}

// ── Misc ───────────────────────────────────────────────────────────────────

/** Perpendicular ticks along a leader-line run (JPL schematic signature). */
export function LeaderTicks({
  x0,
  x1,
  y
}: {
  x0: number
  x1: number
  y: number
}): React.ReactElement {
  const dir = Math.sign(x1 - x0) || 1
  const len = Math.abs(x1 - x0)
  const step = 15
  const count = Math.floor(len / step)
  const ticks: React.ReactElement[] = []
  for (let i = 1; i <= count; i++) {
    const x = x0 + dir * i * step
    ticks.push(<line key={i} x1={x} y1={y - 3} x2={x} y2={y + 3} />)
  }
  return <>{ticks}</>
}

export function Kbd({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 py-px font-sans text-[10px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
      {children}
    </kbd>
  )
}

/** "3m ago"-style relative time for tile badges. */
export function relativeTime(ts: number | undefined): string | null {
  if (!ts) return null
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
