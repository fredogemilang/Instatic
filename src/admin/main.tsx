import { StrictMode } from 'react'
import { createRoot, type ErrorInfo } from 'react-dom/client'
import { Router } from './lib/router'
import { AdminRoutes } from './router'
import { ErrorBoundary, flattenErrorChain, logErrorChain } from '@ui/components/ErrorBoundary'
import { ToastProvider, pushToast } from '@ui/components/Toast'
import '../styles/globals.css'

// Base module registration is deferred to AdminEntry (the lazy admin chunk)
// so the publisher / page-tree / sanitize stack stays out of the eager entry
// bundle. See src/modules/base/index.ts.

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

// React 19 root-level error callbacks — single telemetry funnel that fires
// even for errors caught by an <ErrorBoundary>. Logs follow the project's
// `[<module>]` prefix convention and walk error.cause chains so domain-typed
// errors render their full provenance.
//
// `onCaughtError` fires AFTER a boundary catches; we don't toast for those
// because the boundary itself already toasted with location context.
// `onUncaughtError` fires when no boundary caught — these are the dangerous
// ones; we toast loudly.
// `onRecoverableError` fires when React recovered (e.g. failed hydration that
// fell back to client render). Logged but not toasted.
function handleRootError(
  prefix: string,
  error: unknown,
  info: ErrorInfo,
  toastTitle: string | null,
): void {
  const chain = flattenErrorChain(error)
  logErrorChain(prefix, chain, info.componentStack ?? null)
  if (toastTitle) {
    const head = chain[0]
    pushToast({
      kind: 'error',
      title: toastTitle,
      body: `${head.name}: ${head.message}`,
      location: prefix,
    })
  }
}

createRoot(rootElement, {
  onCaughtError: (error, info) => {
    handleRootError('react-root:caught', error, info, null)
  },
  onUncaughtError: (error, info) => {
    handleRootError(
      'react-root:uncaught',
      error,
      info,
      'Unhandled render error',
    )
  },
  onRecoverableError: (error, info) => {
    handleRootError('react-root:recoverable', error, info, null)
  },
}).render(
  <StrictMode>
    <ErrorBoundary location="admin-shell">
      <Router>
        <AdminRoutes />
      </Router>
    </ErrorBoundary>
    <ToastProvider />
  </StrictMode>
)
