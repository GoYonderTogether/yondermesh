import * as Menu from '@radix-ui/react-dropdown-menu'
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import { cn } from '../utils/cn'

export const DropdownMenu = Menu.Root
export const DropdownMenuTrigger = Menu.Trigger

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof Menu.Content>,
  ComponentPropsWithoutRef<typeof Menu.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <Menu.Portal>
      <Menu.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-menu min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-[var(--shadow-soft-2)]',
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  )
})
DropdownMenuContent.displayName = 'DropdownMenuContent'

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof Menu.Item>,
  ComponentPropsWithoutRef<typeof Menu.Item>
>(function DropdownMenuItem({ className, ...props }, ref) {
  return (
    <Menu.Item
      ref={ref}
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors data-[highlighted]:bg-secondary-button',
        className,
      )}
      {...props}
    />
  )
})
DropdownMenuItem.displayName = 'DropdownMenuItem'

export function DropdownMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-border" />
}
