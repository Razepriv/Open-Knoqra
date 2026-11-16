import { createContext, type ReactNode, useContext, useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface RibbonRegistry {
  /** Where the shell currently shows the ribbon (beside the page, or inside the drawer). */
  target: HTMLElement | null;
  /** Called by a page to say it has a ribbon, and by its cleanup to say it no longer does. */
  register: (label: string | null) => void;
}

export const RibbonContext = createContext<RibbonRegistry | null>(null);

export interface PageRibbonProps {
  /** Names the ribbon landmark and the drawer. */
  label: string;
  children: ReactNode;
}

/**
 * A page's right-hand context ribbon. The shell lives in the pathless `_app` layout, so a page
 * hands its ribbon over by rendering this; the shell decides where it goes: a third pane at
 * 1280px and up, a drawer opened from the top bar below that.
 */
export function PageRibbon({ label, children }: PageRibbonProps) {
  const registry = useContext(RibbonContext);
  const register = registry?.register;
  useEffect(() => {
    register?.(label);
    return () => register?.(null);
  }, [label, register]);
  return registry?.target ? createPortal(children, registry.target) : null;
}
