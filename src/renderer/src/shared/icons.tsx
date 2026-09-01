import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>
const base = (p: P) => ({
  width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.7,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, ...p
})

/* ---- sidebar nav ---- */
export const MicIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  </svg>
)
export const RecordIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none" />
  </svg>
)
export const ChartIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3.5 4v16" />
    <rect x="7" y="12" width="4" height="8" rx="1" />
    <rect x="14" y="7" width="4" height="13" rx="1" />
  </svg>
)
export const BookIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5z" />
    <path d="M9 3v7l2.2-1.6L13.4 10V3" />
  </svg>
)
export const ScissorsIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="6" r="2.6" /><circle cx="6" cy="18" r="2.6" />
    <path d="M8.2 7.7 20 18M20 6 8.2 16.3" />
  </svg>
)
export const TypeIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.5 5.5h9M7 5.5V19" />
    <path d="M13.5 10.5h8M17.5 10.5V19" />
  </svg>
)
export const WandIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 20 16.5 7.5" />
    <path d="m14.5 5.5 4 4" />
    <path d="M19 3v3M21.5 4.5h-3M8 3v2.5M9.3 4.2H6.8" />
  </svg>
)
export const NoteIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
    <path d="M7.5 9h9M7.5 13h9M7.5 17h5" />
  </svg>
)

/* ---- sidebar footer ---- */
export const UsersIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.6a3.2 3.2 0 0 1 0 6.2M17.5 19.5a5.5 5.5 0 0 0-1.8-4.1" />
  </svg>
)
export const GiftIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="8.5" width="18" height="4" rx="1" />
    <path d="M4.5 12.5v7a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-7M12 8.5V20.5" />
    <path d="M12 8.5S10.5 3.5 8 3.5a2.3 2.3 0 0 0 0 5zM12 8.5s1.5-5 4-5a2.3 2.3 0 0 1 0 5z" />
  </svg>
)
export const GearIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7.9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1.9a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V1.9a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
      transform="translate(1.9 1.9) scale(0.84)" />
  </svg>
)
export const HelpIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.3a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4" />
    <path d="M12 17h.01" strokeWidth="2.1" />
  </svg>
)

/* ---- chrome ---- */
export const SidebarIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
    <path d="M9.5 4.5v15" />
  </svg>
)
export const BellIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M18 8.6a6 6 0 1 0-12 0c0 5-2 6.4-2 6.4h16s-2-1.4-2-6.4" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
  </svg>
)
export const AccountIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="10" r="3.1" />
    <path d="M6.2 18.4a6.3 6.3 0 0 1 11.6 0" />
  </svg>
)
export const SearchIcon = (p: P) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
)

/* ---- transcript row actions ---- */
export const PlayIcon = (p: P) => (
  <svg {...base(p)}><path d="M7.5 5.4v13.2L18.5 12z" /></svg>
)
export const CopyIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.2" />
    <path d="M15.5 5.5v-1a1 1 0 0 0-1-1h-10a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h1" />
  </svg>
)
export const FlagIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M5.5 21V3.8" />
    <path d="M5.5 4.4h11.8a.6.6 0 0 1 .5.95L15.6 8.4l2.2 3.05a.6.6 0 0 1-.5.95H5.5z" />
  </svg>
)
export const EllipsisIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </svg>
)
export const UndoIcon = (p: P) => (
  <svg {...base(p)}><path d="M4 9h10a5.5 5.5 0 0 1 0 11h-3" /><path d="m7.5 5.5-3.5 3.5 3.5 3.5" /></svg>
)
export const RetryIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" /><path d="M20.5 4v4.5H16" />
  </svg>
)
export const TrashIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6.5h16M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7" />
    <path d="M6.5 6.5 7.4 20a1 1 0 0 0 1 .95h7.2a1 1 0 0 0 1-.95l.9-13.5" />
  </svg>
)
export const AudioFileIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M13.5 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8.5z" />
    <path d="M13.5 3.5v5h5" />
  </svg>
)

/* ---- flow bar ---- */
export const GlobeIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.2 9.5h17.6M3.2 14.5h17.6" />
    <path d="M12 3a15 15 0 0 1 0 18A15 15 0 0 1 12 3" />
  </svg>
)
export const ChevronLeftIcon = (p: P) => (
  <svg {...base(p)}><path d="m14.5 5.5-6.5 6.5 6.5 6.5" /></svg>
)

/* ---- brand ---- */
/** The Flow mark: four vertical audio-meter bars of varying height. */
export const FlowMark = ({ size = 18, ...p }: P & { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...p}>
    <rect x="2"    y="7"   width="2.9" height="10"   rx="1.45" />
    <rect x="7.05" y="3.5" width="2.9" height="17"   rx="1.45" />
    <rect x="12.1" y="9"   width="2.9" height="6"    rx="1.45" />
    <rect x="17.15" y="5.5" width="2.9" height="13"  rx="1.45" />
  </svg>
)
