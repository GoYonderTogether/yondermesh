import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '../utils/cn'

/**
 * Card：基础容器，遵循 design/00 §6 规约。
 * variant default（默认带阴影/边框）/ outline（仅边框）/ ghost（无边框无阴影）。
 */
const cardVariants = cva(
  'rounded-xl border text-card-foreground',
  {
    variants: {
      variant: {
        default: 'border-border bg-card p-4 shadow-[var(--shadow-soft-1)]',
        outline: 'border-border bg-card p-4',
        ghost: 'border-transparent bg-transparent p-4',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface CardProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant, ...props },
  ref,
) {
  return <div ref={ref} className={cn(cardVariants({ variant }), className)} {...props} />
})
Card.displayName = 'Card'

/** Badge：标签/状态徽章，遵循 design/00 §7 规约。 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      variant: {
        solid: 'bg-primary text-primary-foreground',
        soft: 'bg-secondary text-secondary-foreground',
        outline: 'border border-border-strong text-foreground',
        success: 'bg-success/15 text-success',
        warning: 'bg-warning/15 text-warning',
        destructive: 'bg-destructive/15 text-destructive',
      },
    },
    defaultVariants: { variant: 'soft' },
  },
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant, ...props },
  ref,
) {
  return <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
})
Badge.displayName = 'Badge'

/** Separator：分隔线，遵循 design/00 §6 规约。 */
export const Separator = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Separator({ className, ...props }, ref) {
    return <div ref={ref} className={cn('h-px w-full bg-border', className)} {...props} />
  },
)
Separator.displayName = 'Separator'
