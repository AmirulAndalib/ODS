import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardSignInGate, { useDashboardSession } from '../DashboardSignInGate'
import { ThemeProvider } from '../../contexts/ThemeContext'

const response = (body, status = 200, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  json: async () => body,
})
const signInRequired = () => response(
  { detail: 'Sign in to the ODS dashboard to continue.' }, 401, { 'x-ods-sign-in': 'required' },
)
const json = (body, status = 200) => response(body, status)

function Dashboard() {
  const { session, signOut } = useDashboardSession()
  return (
    <div>
      <p>Dashboard content</p>
      {session && <button type="button" onClick={signOut}>Sign out</button>}
    </div>
  )
}

const renderGate = () => render(
  <ThemeProvider><DashboardSignInGate><Dashboard /></DashboardSignInGate></ThemeProvider>,
)

describe('DashboardSignInGate', () => {
  let fetchMock

  beforeEach(() => {
    fetchMock = vi.fn()
    window.fetch = fetchMock
    globalThis.fetch = fetchMock
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/')
  })

  it('shows the dashboard straight away for a browser on the ODS machine', async () => {
    fetchMock.mockResolvedValueOnce(json({ signedIn: true, session: false }))
    renderGate()
    expect(await screen.findByText('Dashboard content')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/dashboard-session', { credentials: 'same-origin' })
  })

  it('asks for the dashboard key only when nginx requires sign-in', async () => {
    fetchMock
      .mockResolvedValueOnce(signInRequired())
      .mockResolvedValueOnce(json({ detail: 'That dashboard key is not correct.' }, 401))
      .mockResolvedValueOnce(json({ signedIn: true }))
    renderGate()

    const input = await screen.findByLabelText('Dashboard key')
    expect(screen.queryByText('Dashboard content')).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That dashboard key is not correct.')

    fireEvent.change(input, { target: { value: 'the-real-key' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Dashboard content')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    const [url, options] = fetchMock.mock.calls[2]
    expect(url).toBe('/api/auth/dashboard-session/login')
    expect(JSON.parse(options.body)).toEqual({ key: 'the-real-key' })
  })

  it('signs in with a one-time link and removes the token from the address bar', async () => {
    const token = 'a'.repeat(43)
    window.history.replaceState(null, '', `/models#ods-login=${token}`)
    fetchMock.mockResolvedValueOnce(json({ signedIn: true }))
    renderGate()

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/models')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token })
  })

  it('explains an expired or reused link', async () => {
    window.history.replaceState(null, '', `/#ods-login=${'b'.repeat(43)}`)
    fetchMock.mockResolvedValueOnce(json({ detail: 'That sign-in link has expired or was already used.' }, 401))
    renderGate()
    expect(await screen.findByRole('alert')).toHaveTextContent('expired or was already used')
  })

  it('returns to sign-in when a later request is turned away, and after signing out', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ signedIn: true, session: true }))
      .mockResolvedValueOnce(signInRequired())
    renderGate()
    expect(await screen.findByText('Dashboard content')).toBeInTheDocument()

    await window.fetch('/api/status')
    expect(await screen.findByLabelText('Dashboard key')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('session ended')
  })

  it('signs out of this browser', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ signedIn: true, session: true }))
      .mockResolvedValueOnce(json({ signedIn: false }))
    renderGate()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByLabelText('Dashboard key')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/dashboard-session/logout', { method: 'POST', credentials: 'same-origin' })
  })

  it('never gates ODS Talk, which has its own session', async () => {
    window.history.replaceState(null, '', '/talk')
    renderGate()
    expect(screen.getByText('Dashboard content')).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled())
  })
})
