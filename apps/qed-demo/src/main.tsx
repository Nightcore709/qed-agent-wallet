import { Component, type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/app.css'
import { App } from './app/App.tsx'

/** If drawing a page fails, say so plainly. The money and the records live on the server and are not affected. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } { return { error } }
  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <main className="welcome stack">
        <h1>This page could not be drawn</h1>
        <p>The interface hit a fault while drawing this page. Your paper money, instructions and records are held by the QED service, not by this page, and are unaffected. Anything QED was doing carries on.</p>
        <p className="small muted">The fault: {this.state.error.message}</p>
        <div className="row"><a className="btn fill" href="/">Open home</a><button type="button" className="btn" onClick={() => location.reload()}>Reload this page</button></div>
      </main>
    )
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><Boundary><App /></Boundary></StrictMode>)
