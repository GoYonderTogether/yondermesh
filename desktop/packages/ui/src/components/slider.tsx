import * as SliderPrimitive from '@radix-ui/react-slider'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import { cn } from '../utils/cn'

/**
 * Slider：受控滑块，遵循 design/00 §6 规约。
 * 受控命名：value / defaultValue / onValueChange。
 */
export const Slider = forwardRef<
  ElementRef<typeof SliderPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(function Slider({ className, ...props }, ref) {
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        'relative flex w-full touch-none select-none items-center disabled:opacity-[0.38]',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block size-4 rounded-full border border-border-strong bg-background shadow-[var(--shadow-soft-1)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none" />
    </SliderPrimitive.Root>
  )
})
Slider.displayName = 'Slider'
