'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Group,
  PasswordInput,
  Stack,
  Text,
  Title,
} from '@mantine/core'
import type { AdminAuthState } from '../../../lib/admin-client'

/**
 * Authentication gate for the admin surface.
 *
 * Every state below renders beneath `GdsProvider`, so all typography, spacing,
 * colour, radius and focus treatment inherits GDS tokens.
 *
 * The credential never enters the client bundle: it is typed by the operator,
 * posted once, and exchanged for an `HttpOnly` cookie the page cannot read.
 */

type Props = { children: React.ReactNode }

const AUTH_STATE_EVENT = 'rae:admin-auth-state'

/** Lets `adminFetch` push a state change from anywhere without prop drilling. */
export function publishAuthState(state: AdminAuthState) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(AUTH_STATE_EVENT, { detail: state }))
}

export function AdminAuthGate({ children }: Props) {
  const [state, setState] = useState<AdminAuthState>({ status: 'unknown' })
  const [credential, setCredential] = useState('')
  const [countdown, setCountdown] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onState = (event: Event) => {
      setState((event as CustomEvent<AdminAuthState>).detail)
    }
    window.addEventListener(AUTH_STATE_EVENT, onState)
    return () => window.removeEventListener(AUTH_STATE_EVENT, onState)
  }, [])

  // Probe once on mount. /api/health reports whether enforcement is even on,
  // so the gate does not demand a sign-in the server would ignore.
  useEffect(() => {
    let cancelled = false
    fetch('/api/health', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return
        if (body?.adminAuth !== 'enabled') {
          setState({ status: 'signed-in' })
          return
        }
        return fetch('/api/admin/tenants', { credentials: 'same-origin' }).then((r) => {
          if (cancelled) return
          setState(r.ok ? { status: 'signed-in' } : { status: 'signed-out' })
        })
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            status: 'offline',
            message: 'Could not reach the server. Check your connection and retry.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Rate-limit countdown. Ticks once per second and exposes remaining time as
  // TEXT: a purely visual timer is not perceivable to a screen-reader user.
  useEffect(() => {
    if (state.status !== 'rate-limited') return
    setCountdown(state.retryAfterSeconds)
    const timer = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) {
          clearInterval(timer)
          setState({ status: 'signed-out' })
          return 0
        }
        return n - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [state])

  // Return focus to the credential field whenever it becomes actionable, so a
  // keyboard user is not stranded after a failed attempt.
  useEffect(() => {
    if (state.status === 'signed-out' || state.status === 'invalid') {
      inputRef.current?.focus()
    }
  }, [state.status])

  const signIn = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      const value = credential.trim()
      if (value === '') return
      setState({ status: 'signing-in' })
      try {
        const res = await fetch('/api/admin/session', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ credential: value }),
        })
        const body = await res.json().catch(() => ({}))
        if (res.ok) {
          setCredential('')
          setState({ status: 'signed-in' })
          return
        }
        if (res.status === 429) {
          setState({
            status: 'rate-limited',
            message: body.message ?? 'Too many attempts.',
            retryAfterSeconds: Number(res.headers.get('retry-after') ?? '') || 60,
          })
          return
        }
        if (res.status === 503) {
          setState({
            status: 'misconfigured',
            message: body.message ?? 'Sign-in is not available.',
          })
          return
        }
        setState({
          status: 'invalid',
          message: body.message ?? 'The provided admin credential was not accepted.',
        })
      } catch {
        setState({
          status: 'offline',
          message: 'Could not reach the server. Check your connection and retry.',
        })
      }
    },
    [credential]
  )

  if (state.status === 'signed-in') {
    return <>{children}</>
  }

  if (state.status === 'unknown') {
    return (
      <Card withBorder p="lg" maw={480} mx="auto" mt="xl" aria-busy="true">
        <Text>Checking your session…</Text>
      </Card>
    )
  }

  const busy = state.status === 'signing-in'
  const locked = state.status === 'rate-limited'
  const errorMessage =
    state.status === 'invalid' || state.status === 'misconfigured' || state.status === 'offline'
      ? state.message
      : state.status === 'expired'
        ? 'Your session ended. Sign in to continue.'
        : null

  return (
    <Card withBorder p="lg" maw={480} mx="auto" mt="xl" component="section">
      <form onSubmit={signIn} noValidate>
        <Stack gap="md">
          <Title order={1} size="h3">
            Admin sign-in
          </Title>

          {/* assertive for expiry: the operator's next action will otherwise
              fail. polite for everything else. */}
          <div
            aria-live={state.status === 'expired' ? 'assertive' : 'polite'}
            aria-atomic="true"
          >
            {errorMessage ? (
              <Alert
                color={state.status === 'misconfigured' ? 'yellow' : 'red'}
                title={state.status === 'misconfigured' ? 'Server not configured' : 'Sign-in failed'}
                id="admin-signin-error"
              >
                {errorMessage}
              </Alert>
            ) : null}
            {locked ? (
              <Alert color="yellow" title="Too many attempts" id="admin-signin-locked">
                {state.message} You can try again in {countdown} second
                {countdown === 1 ? '' : 's'}.
              </Alert>
            ) : null}
          </div>

          <PasswordInput
            ref={inputRef}
            label="Admin credential"
            description="Provided by the repository owner. Never stored in the browser."
            autoComplete="current-password"
            value={credential}
            onChange={(e) => setCredential(e.currentTarget.value)}
            disabled={busy || locked}
            required
            aria-describedby={
              errorMessage ? 'admin-signin-error' : locked ? 'admin-signin-locked' : undefined
            }
          />

          <Group justify="flex-end">
            <Button
              type="submit"
              loading={busy}
              disabled={busy || locked || credential.trim() === ''}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  )
}
