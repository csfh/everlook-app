import { useId, type ReactNode } from 'react'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

export function ViewTitle({
  id,
  title,
  description
}: {
  id: string
  title: string
  description?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <h1 id={id} className="font-display text-xl font-semibold">
        {title}
      </h1>
      {description ? (
        <p className="text-muted-foreground max-w-prose text-sm text-pretty">{description}</p>
      ) : null}
    </div>
  )
}

/** A numbered step title. The number becomes a check once the step is done. */
export function StepHeading({
  step,
  done,
  children
}: {
  step: number
  done: boolean
  children: ReactNode
}) {
  return (
    <span className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums',
          done ? 'bg-chart-2 text-background' : 'bg-muted text-muted-foreground'
        )}
      >
        {done ? <CheckIcon className="size-3.5" strokeWidth={3} /> : step}
      </span>
      <span className="sr-only">
        Step {step}
        {done ? ', done' : ''}:{' '}
      </span>
      {children}
    </span>
  )
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`view-panel rounded-xl bg-card ring-1 ring-foreground/10 ${className ?? ''}`}>
      {children}
    </div>
  )
}

export function Section({
  title,
  description,
  defaultOpen = false,
  children
}: {
  title: string
  description: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/section border-b last:border-b-0">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-muted-foreground text-sm text-pretty">{description}</span>
        </span>
        <ChevronDownIcon className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 group-data-[state=open]/section:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-4 px-4 pt-1 pb-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  type = 'text',
  placeholder,
  disabled,
  min
}: {
  label: string
  value: string | number
  onChange: (value: string) => void
  hint?: string
  type?: 'text' | 'number' | 'url'
  placeholder?: string
  disabled?: boolean
  min?: number
}) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        min={min}
        spellCheck={false}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
    </Field>
  )
}

export function SwitchRow({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange
}: {
  id: string
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <Field orientation="horizontal" data-disabled={disabled}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription id={`${id}-description`}>{description}</FieldDescription>
      </FieldContent>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        onCheckedChange={(next) => {
          if (typeof next === 'boolean') onCheckedChange(next)
        }}
      />
    </Field>
  )
}

export function SaveBar({
  dirty,
  busy,
  note,
  saveLabel,
  onSave,
  onRevert
}: {
  dirty: boolean
  busy: boolean
  note: string
  saveLabel: string
  onSave: () => void
  onRevert: () => void
}) {
  if (!dirty) return null
  return (
    <div className="save-bar sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-popover px-4 py-3 shadow-lg ring-1 ring-foreground/15">
      <p className="text-sm" role="status">
        {note}
      </p>
      <div className="flex gap-2">
        <Button variant="ghost" disabled={busy} onClick={onRevert}>
          Revert
        </Button>
        <Button variant="gold" disabled={busy} onClick={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  )
}
