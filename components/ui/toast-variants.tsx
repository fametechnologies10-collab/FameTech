'use client'

import { toast as sonnerToast } from 'sonner'

type ToastType = 'success' | 'error' | 'info' | 'warning'

const TYPE_COLORS: Record<ToastType, {
  bandBg: string   // solid opaque background for the left icon band
  bandBorder: string // right-side separator of the band
  stroke: string   // progress bar + card outer border accent
  border: string   // card outer border (subtle type tint)
  shadow: string   // card glow (subtle type tint)
}> = {
  success: { bandBg: '#047857', bandBorder: '#065F46', stroke: '#4ade80', border: 'rgba(4,120,87,0.60)',   shadow: 'rgba(74,222,128,0.06)'  },
  error:   { bandBg: '#B71C1C', bandBorder: '#991B1B', stroke: '#f87171', border: 'rgba(183,28,28,0.60)', shadow: 'rgba(248,113,113,0.06)' },
  info:    { bandBg: '#0057FF', bandBorder: '#0046CC', stroke: '#60a5fa', border: 'rgba(0,87,255,0.60)',   shadow: 'rgba(96,165,250,0.06)'  },
  warning: { bandBg: '#B45309', bandBorder: '#92400E', stroke: '#fbbf24', border: 'rgba(180,83,9,0.60)',  shadow: 'rgba(251,191,36,0.06)'  },
}

// color prop lets the left band pass '#ffffff' for icon-on-solid-bg contrast
function TypeIcon({ type, size = 18, color }: { type: ToastType; size?: number; color?: string }) {
  const c = color ?? TYPE_COLORS[type].stroke
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {type === 'success' && (
        <path d="M5 13l4 4L19 7" stroke={c} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {type === 'error' && (
        <path d="M18 6L6 18M6 6l12 12" stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      )}
      {type === 'info' && (
        <path d="M12 8v4m0 4h.01" stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      )}
      {type === 'warning' && (
        <path
          d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          stroke={c}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// SplitPanelToast — used for ALL toast types (success, error, info, warning)
// Right panel background + text uses the active CSS theme (light / dark).
// Left icon band keeps the type-color tint which works on any background.
// ---------------------------------------------------------------------------

interface SplitPanelToastProps {
  id: string | number
  title: string
  type: ToastType
  duration: number
  /** Small uppercase label above the message. Defaults to the platform brand;
   *  the storefront overrides it with the shop's own name (white-label). */
  brand?: string
}

export function SplitPanelToast({ id, title, type, duration, brand = 'FameTech' }: SplitPanelToastProps) {
  const colors = TYPE_COLORS[type]

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        width: '380px',
        maxWidth: 'calc(100vw - 32px)',
        borderRadius: '14px',
        overflow: 'hidden',
        /* Type-color outer border provides the accent ring */
        border: `1.5px solid ${colors.border}`,
        /*
         * Shadow: subtle depth (works in both themes) + faint type-color glow.
         * Avoid rgba(0,0,0,>0.2) — too harsh in light mode.
         */
        boxShadow: 'var(--ft-shadow-float)',
        animation: 'kf-toast-in 0.4s cubic-bezier(0.16,1,0.3,1) both',
      }}
    >
      {/* Left icon band — solid opaque type color, white icon for guaranteed contrast */}
      <div
        style={{
          width: '60px',
          flexShrink: 0,
          background: colors.bandBg,
          borderRight: `1px solid ${colors.bandBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <TypeIcon type={type} size={22} color="#ffffff" />
      </div>

      {/* Right text panel — inherits active theme via CSS variables */}
      <div
        style={{
          flex: 1,
          background: 'var(--ft-raised-bg)',
          padding: '11px 38px 11px 13px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: '2px',
          minWidth: 0,
        }}
      >
        {/* App label — uses muted foreground, readable in both themes */}
        <span
          style={{
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '0.13em',
            textTransform: 'uppercase',
            color: 'var(--ft-muted)',
            lineHeight: 1,
            userSelect: 'none',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '100%',
          }}
        >
          {brand}
        </span>

        {/* Message — uses card-foreground: dark text on light, light text on dark */}
        <span
          style={{
            fontFamily: 'var(--font-ft-body), system-ui, -apple-system, sans-serif',
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--ft-ink)',
            lineHeight: 1.4,
            wordBreak: 'break-word',
          }}
        >
          {title}
        </span>
      </div>

      {/* Close button — uses muted/border variables, correct in both themes */}
      <button
        onClick={(e) => { e.stopPropagation(); sonnerToast.dismiss(id) }}
        style={{
          position: 'absolute',
          top: '9px',
          right: '9px',
          background: 'var(--ft-surface)',
          border: '1px solid var(--ft-lo)',
          borderRadius: '6px',
          color: 'var(--ft-muted)',
          cursor: 'pointer',
          padding: '3px',
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--ft-ink)'
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--ft-muted)'
        }}
        aria-label="Dismiss"
      >
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
          <path d="M11 3L3 11M3 3l8 8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>

      {/* Progress bar — fills over ANIM_DURATION ms then toast auto-dismisses */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          height: '3px',
          width: '0%',
          background: colors.stroke,
          boxShadow: `0 0 6px ${colors.stroke}`,
          '--kf-dur': `${duration}ms`,
          animation: 'kf-bar-fill var(--kf-dur) linear forwards',
        } as React.CSSProperties & { '--kf-dur': string }}
      />
    </div>
  )
}
