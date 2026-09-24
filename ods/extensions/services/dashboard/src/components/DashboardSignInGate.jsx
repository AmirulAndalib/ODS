import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import ODSLogo from './ODSLogo'
import WallpaperVideo from './WallpaperVideo'
import './dashboard-sign-in.css'

/**
 * Dashboard sign-in for access from another device.
 *
 * nginx lets a browser on the ODS machine itself (http://localhost) use the
 * dashboard without signing in. Any other route - LAN mode, ODS proxy, a
 * reverse proxy or Tailscale Serve - is answered with
 * `401` + `X-ODS-Sign-In: required` until this browser holds a dashboard
 * session. This gate shows the sign-in screen only in that case, so local
 * use is unchanged. ODS Talk has its own session and is never gated here.
 */

const DashboardSessionContext = createContext({ session: false, signOut: async () => {} })

export const useDashboardSession = () => useContext(DashboardSessionContext)

const LOGIN_FRAGMENT = /(?:^#|&)ods-login=([A-Za-z0-9_-]{16,128})(?:&|$)/

export function signInRequired(response) {
  return response?.status === 401 && response.headers?.get?.('x-ods-sign-in') === 'required'
}

function isTalkLocation() {
  return window.location.hostname.startsWith('talk.') || window.location.pathname.startsWith('/talk')
}

async function detailOf(response, fallback) {
  const body = await response.json().catch(() => ({}))
  return typeof body.detail === 'string' ? body.detail : fallback
}

export default function DashboardSignInGate({ children }) {
  const [bypass] = useState(isTalkLocation)
  const [state, setState] = useState(bypass ? 'ready' : 'checking')
  const [session, setSession] = useState(false)
  const [message, setMessage] = useState('')
  // One link sign-in per page load, shared across StrictMode's re-run.
  const linkAttempt = useRef(null)

  const signIn = useCallback(async (credential) => {
    let response
    try {
      response = await fetch('/api/auth/dashboard-session/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credential),
      })
    } catch {
      setMessage('Could not reach ODS. Check the connection and try again.')
      setState('sign-in')
      return
    }
    if (response.ok) {
      setSession(true)
      setMessage('')
      setState('ready')
      return
    }
    setMessage(await detailOf(response, 'Sign-in failed. Try again.'))
    setState('sign-in')
  }, [])

  useEffect(() => {
    if (bypass) return undefined
    let cancelled = false
    const check = async () => {
      const link = window.location.hash.match(LOGIN_FRAGMENT)
      if (link && !linkAttempt.current) {
        // Drop the one-time token from the address bar and history first.
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
        linkAttempt.current = signIn({ token: link[1] })
      }
      if (linkAttempt.current) {
        await linkAttempt.current
        return
      }
      try {
        const response = await fetch('/api/auth/dashboard-session', { credentials: 'same-origin' })
        if (cancelled) return
        if (signInRequired(response)) {
          setState('sign-in')
          return
        }
        if (response.ok) {
          const body = await response.json().catch(() => ({}))
          if (!cancelled) setSession(body.session === true)
        }
      } catch {
        // Unreachable API: let the dashboard show its usual service status.
      }
      if (!cancelled) setState('ready')
    }
    check()
    return () => { cancelled = true }
  }, [bypass, signIn])

  // An expired or cleared session returns the user to sign-in instead of
  // leaving every panel in an error state.
  useEffect(() => {
    if (bypass || state !== 'ready') return undefined
    const original = window.fetch
    const guarded = async (...args) => {
      const response = await original(...args)
      if (signInRequired(response)) {
        setSession(false)
        setMessage('Your dashboard session ended. Sign in again to continue.')
        setState('sign-in')
      }
      return response
    }
    window.fetch = guarded
    return () => {
      if (window.fetch === guarded) window.fetch = original
    }
  }, [bypass, state])

  const signOut = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/dashboard-session/logout', { method: 'POST', credentials: 'same-origin' })
      if (!response.ok) throw new Error('Sign-out rejected')
    } catch {
      setMessage('Could not sign out. Check the connection and try again.')
      return
    }
    setSession(false)
    setMessage('You signed out of this browser.')
    setState('sign-in')
  }, [])

  if (state === 'checking') return <div className="min-h-screen bg-theme-bg" aria-busy="true" />
  if (state === 'sign-in') return <SignInScreen message={message} onSubmit={key => signIn({ key })} />
  return (
    <DashboardSessionContext.Provider value={{ session, signOut }}>
      {message && <p role="alert" className="ods-signout-error">{message}</p>}
      {children}
    </DashboardSessionContext.Provider>
  )
}

// A quiet silhouette of the workspace under the frosted pane. Decorative only:
// nothing from the dashboard loads until sign-in succeeds.
function WorkspaceSilhouette() {
  return (
    <div className="ods-signin-ghost" aria-hidden="true">
      <div className="ods-signin-ghost-rail">
        <ODSLogo />
        {[0, 1, 2, 3, 4, 5, 6, 7].map(index => <b key={index}><i /></b>)}
      </div>
      <div className="ods-signin-ghost-shell"><i /><i /><i /><i /><i /></div>
    </div>
  )
}

function SignInScreen({ message, onSubmit }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event) => {
    event.preventDefault()
    if (busy || !key.trim()) return
    setBusy(true)
    await onSubmit(key.trim())
    setBusy(false)
  }
  return (
    <div className="ods-signin">
      <WallpaperVideo />
      <WorkspaceSilhouette />
      <div className="ods-signin-veil">
        <form className="ods-signin-card" onSubmit={submit} aria-labelledby="ods-signin-title">
          <ODSLogo />
          <h1 id="ods-signin-title">Sign in to ODS</h1>
          <p className="ods-signin-lede">Enter your dashboard key to continue.</p>
          <div className="ods-signin-field">
            <input
              type="password"
              aria-label="Dashboard key"
              placeholder="Dashboard key"
              autoComplete="current-password"
              spellCheck={false}
              maxLength={512}
              autoFocus
              value={key}
              onChange={event => setKey(event.target.value)}
            />
            <button type="submit" className="ods-signin-submit" aria-label="Sign in" aria-busy={busy} disabled={busy || !key.trim()}>
              <ArrowRight size={16} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
          {message && <p role="alert" className="ods-signin-message">{message}</p>}
          <details className="ods-signin-help">
            <summary>Need help signing in?</summary>
            <p className="ods-signin-hint">
            For a one-click link, run <code>ods dashboard-login</code> on the ODS machine.
            The key is <code>DASHBOARD_API_KEY</code> in its <code>.env</code>.
            </p>
          </details>
        </form>
      </div>
    </div>
  )
}
