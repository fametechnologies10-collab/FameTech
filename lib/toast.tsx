'use client'

import { toast as sonnerToast } from 'sonner'
import type { ExternalToast } from 'sonner'
import { SplitPanelToast } from '@/components/ui/toast-variants'

const DEFAULT_DURATION = 4000  // how long toast stays on screen (ms)
const ANIM_DURATION    = 3000  // how long ring/bar fill animation runs (ms)

// Brand label shown on every toast. Defaults to the platform brand; the storefront
// calls setBrand(shop.shop_name) on mount so guests see the shop's own name on
// error/success toasts (white-label), and resets to the default on unmount.
let currentBrand = 'KiNG FLEXY'
function setBrand(name?: string | null): void {
  currentBrand = name && name.trim() ? name.trim() : 'KiNG FLEXY'
}

function success(title: string, opts?: ExternalToast): void {
  const dur = opts?.duration ?? DEFAULT_DURATION
  const brand = currentBrand
  sonnerToast.custom(
    (id) => <SplitPanelToast id={id} title={title} type="success" duration={ANIM_DURATION} brand={brand} />,
    { ...opts, duration: dur },
  )
}

function error(title: string, opts?: ExternalToast): void {
  const dur = opts?.duration ?? DEFAULT_DURATION
  const brand = currentBrand
  sonnerToast.custom(
    (id) => <SplitPanelToast id={id} title={title} type="error" duration={ANIM_DURATION} brand={brand} />,
    { ...opts, duration: dur },
  )
}

function info(title: string, opts?: ExternalToast): void {
  const dur = opts?.duration ?? DEFAULT_DURATION
  const brand = currentBrand
  sonnerToast.custom(
    (id) => <SplitPanelToast id={id} title={title} type="info" duration={ANIM_DURATION} brand={brand} />,
    { ...opts, duration: dur },
  )
}

function warning(title: string, opts?: ExternalToast): void {
  const dur = opts?.duration ?? DEFAULT_DURATION
  const brand = currentBrand
  sonnerToast.custom(
    (id) => <SplitPanelToast id={id} title={title} type="warning" duration={ANIM_DURATION} brand={brand} />,
    { ...opts, duration: dur },
  )
}

function loading(title: string, opts?: ExternalToast): string | number {
  return sonnerToast.loading(title, opts)
}

function dismiss(id?: string | number): void {
  sonnerToast.dismiss(id)
}

export const toast = { success, error, info, warning, loading, dismiss, setBrand }
