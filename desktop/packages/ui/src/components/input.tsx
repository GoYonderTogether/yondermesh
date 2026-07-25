import { forwardRef } from 'react'
import { cn } from '../utils/cn'

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          'h-9 w-full rounded-lg bg-input px-3 text-sm text-foreground outline-none transition-shadow placeholder:text-text-quaternary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-[0.38]',
          className,
        )}
        {...props}
      />
    )
  },
)
Input.displayName = 'Input'

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'w-full resize-none rounded-lg bg-input px-3 py-2 text-sm text-foreground outline-none transition-shadow placeholder:text-text-quaternary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-[0.38]',
        className,
      )}
      {...props}
    />
  )
})
Textarea.displayName = 'Textarea'
