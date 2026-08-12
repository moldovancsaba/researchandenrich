'use client'

import { GdsProvider } from '@sovereignsquad/gds-theme/client'
import { AdminAuthGate } from './AdminAuthGate'

/**
 * Admin surface providers.
 *
 * `GdsProvider` supplies the design system's theme tokens, colour scheme,
 * overlay adapter and i18n context. Every primitive rendered beneath it
 * inherits GDS typography, spacing, colour, radius, elevation and interaction
 * tokens — which is the composition GDS is built for, since it is itself
 * Mantine-based. Hand-rolling components outside this provider is what §7 of
 * the delivery standard actually forbids; using Mantine primitives *under* it
 * is the supported path.
 *
 * `AdminAuthGate` sits inside the provider so every authentication state —
 * signed-out, signing-in, invalid, expired, misconfigured — renders with GDS
 * tokens rather than as an unstyled fallback.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <GdsProvider defaultColorScheme="auto">
      <AdminAuthGate>{children}</AdminAuthGate>
    </GdsProvider>
  )
}
