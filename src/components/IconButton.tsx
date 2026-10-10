import * as Tooltip from '@radix-ui/react-tooltip';
import type { ButtonHTMLAttributes } from 'react';
export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <Tooltip.Root><Tooltip.Trigger asChild><button {...props} type="button" className={`icon-button ${props.className || ''}`} aria-label={label}>{children}</button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={7}>{label}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}
