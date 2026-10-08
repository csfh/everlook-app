import { cn } from 'cn'
import type { StatusTone } from '@/status'

const tones: Record<StatusTone, string> = {
  ok: 'bg-chart-2',
  busy: 'animate-pulse bg-[color-mix(in_oklch,var(--hero-gold),var(--hero-ink)_45%)] dark:bg-hero-gold',
  error: 'bg-destructive-foreground',
  idle: 'bg-muted-foreground/50'
}

export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2 shrink-0 rounded-full', tones[tone], className)}
    />
  )
}
