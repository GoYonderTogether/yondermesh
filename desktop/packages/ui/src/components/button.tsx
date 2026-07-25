import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef } from 'react'
import { cn } from '../utils/cn'

/**
 * Button：variant（视觉）/ size（尺寸）/ asChild（多态）三正交，遵循 design/00 §6 规约。
 * disabled 态用 state layer token（§5）统一不透明度；hover/active 用语义 hover token
 * （design/00 §5 例外条款：复杂场景保留具体值）。
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-[var(--opacity-disabled)] [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        solid: 'bg-primary text-primary-foreground hover:opacity-90',
        soft: 'bg-secondary-button text-foreground hover:bg-secondary-button-hover',
        outline: 'border border-border-strong text-foreground hover:bg-secondary-button',
        ghost: 'text-foreground hover:bg-secondary-button',
        link: 'text-foreground underline-offset-4 hover:underline',
        destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
      },
      size: {
        xs: 'h-6 px-2 text-xs',
        sm: 'h-7 px-2.5 text-sm',
        md: 'h-8 px-3.5 text-sm',
        lg: 'h-10 px-5 text-base',
        icon: 'size-8 p-0',
      },
    },
    defaultVariants: {
      variant: 'solid',
      size: 'md',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  )
})
Button.displayName = 'Button'

export { buttonVariants }
