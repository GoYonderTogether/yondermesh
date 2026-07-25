import * as LabelPrimitive from '@radix-ui/react-label'
import { cva, type VariantProps } from 'class-variance-authority'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import { cn } from '../utils/cn'

const labelVariants = cva(
  'select-none text-sm font-medium text-foreground peer-disabled:opacity-[0.38]',
  {
    variants: {
      size: {
        sm: 'text-xs',
        md: 'text-sm',
        lg: 'text-base',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

export interface LabelProps
  extends ComponentPropsWithoutRef<typeof LabelPrimitive.Root>,
    VariantProps<typeof labelVariants> {}

export const Label = forwardRef<ElementRef<typeof LabelPrimitive.Root>, LabelProps>(
  function Label({ className, size, ...props }, ref) {
    return (
      <LabelPrimitive.Root
        ref={ref}
        className={cn(labelVariants({ size }), className)}
        {...props}
      />
    )
  },
)
Label.displayName = 'Label'
