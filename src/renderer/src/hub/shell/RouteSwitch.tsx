import type { ReactNode, Ref } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { presets, useExitInert } from '../../shared/motion'
import type { Route } from './TitleBar'

/** Nav order, left to right: the route switch travels in this direction (docs/MOTION.md §4.2). */
export const ROUTE_ORDER: Route[] = ['dictation', 'snippets', 'transforms', 'settings']

/** +1 when `to` sits right of `from` in the nav, -1 when left, 0 when it is the same route. */
export const routeDir = (from: Route, to: Route): number =>
  Math.sign(ROUTE_ORDER.indexOf(to) - ROUTE_ORDER.indexOf(from))

/** Moves focus to the live route layer (mic picker footer, §4.4). */
export function focusRoute(): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('.shell__route:not([inert])')?.focus({ preventScroll: true })
  })
}

/**
 * Route switch (§4.2): the outgoing layer fades (`dur.flash`), goes inert and
 * leaves the flow at once; the incoming one fades in with a 6 px nudge from
 * the side it travels from. A click mid-switch turns the incoming layer into
 * the outgoing one from its current opacity, so nothing queues or stacks.
 */
export default function RouteSwitch({ route, dir, children }: {
  route: Route; dir: number; children: ReactNode
}): React.JSX.Element {
  return (
    <AnimatePresence mode="popLayout" initial={false} custom={dir}>
      <RouteLayer key={route} dir={dir}>{children}</RouteLayer>
    </AnimatePresence>
  )
}

function RouteLayer({ dir, children, ref }: {
  dir: number; children: ReactNode; ref?: Ref<HTMLDivElement>
}): React.JSX.Element {
  const inert = useExitInert()
  return (
    <m.div
      ref={ref}
      className="shell__route"
      tabIndex={-1}
      inert={inert.inert}
      style={inert.style}
      variants={presets.routeSwitch}
      custom={dir}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {children}
    </m.div>
  )
}
