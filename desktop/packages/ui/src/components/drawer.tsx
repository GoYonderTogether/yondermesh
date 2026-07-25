import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react'
import { cn } from '../utils/cn'

export const Drawer = DialogPrimitive.Root
export const DrawerTrigger = DialogPrimitive.Trigger
export const DrawerClose = DialogPrimitive.Close

const SIDE_INSET: Record<string, string> = {
  right: 'fixed inset-y-0 right-0 h-full w-full max-w-md border-l',
  left: 'fixed inset-y-0 left-0 h-full w-full max-w-md border-r',
}

/**
 * Drawer：右侧/左侧抽屉（基于 @radix-ui/react-dialog）。
 * 与 Dialog（居中弹窗）互补，用于详情面板、表单等需要常驻侧边的场景。
 */
export const DrawerContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: 'right' | 'left' }
>(function DrawerContent({ className, children, side = 'right', ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-overlay bg-overlay backdrop-blur-sm" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'animate-pop z-overlay flex flex-col bg-popover text-popover-foreground shadow-[var(--shadow-soft-2)] focus:outline-none',
          SIDE_INSET[side] ?? SIDE_INSET.right,
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute right-4 top-4 rounded-md p-1 text-text-tertiary transition-colors hover:bg-secondary-button hover:text-foreground"
        >
          <X className="size-5" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})
DrawerContent.displayName = 'DrawerContent'

export function DrawerHeader({ children }: { children: ReactNode }) {
  return <div className="border-b border-border px-5 py-4">{children}</div>
}

export function DrawerBody({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
}

export function DrawerFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
      {children}
    </div>
  )
}

export const DrawerTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DrawerTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-lg font-semibold text-foreground', className)}
      {...props}
    />
  )
})
DrawerTitle.displayName = 'DrawerTitle'

export const DrawerDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DrawerDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-sm text-text-tertiary', className)}
      {...props}
    />
  )
})
DrawerDescription.displayName = 'DrawerDescription'
