/**
 * OpenLivePageButton — toolbar icon that opens the live site in a new tab.
 *
 * Sits in the Toolbar's right cluster next to `AccountMenuButton`. Rendered
 * by `Toolbar.tsx` itself (not the layout-supplied `rightSlot`) so the button
 * appears on every admin route — Site editor, Content, Plugins, Users,
 * Account, plugin admin pages — with zero per-layout wiring.
 *
 * Target URL:
 *   - Site editor with an active page → that page's public path
 *     (e.g. `/about`).
 *   - Content workspace with a selected entry → the entry's public path
 *     (e.g. `/blog/getting-started`).
 *   - Every other admin route → site root (`/`).
 *
 * The path is read from `useAdminUi` (the tiny shared store) — NOT the
 * editor store — so this component is safe to mount on `AdminPageLayout`
 * without pulling the ~165 KB editor chunk into the non-editor bundle.
 * Each workspace's top-level layout mirrors the current document's
 * public path into `adminUi.activeLivePath` on every render and clears
 * it on unmount; non-editor layouts never write the field, so it
 * naturally stays `null` outside an editing surface.
 */
import { Button } from '@ui/components/Button'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { useAdminUi } from '@admin/state/adminUi'

export function OpenLivePageButton() {
  const activeLivePath = useAdminUi((s) => s.activeLivePath)
  const target = activeLivePath ?? '/'
  const tooltip = activeLivePath ? 'Open live page' : 'Open live site'

  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={tooltip}
      tooltip={tooltip}
      data-testid="toolbar-open-live-page-btn"
      onClick={() => {
        window.open(target, '_blank', 'noopener,noreferrer')
      }}
    >
      <ExternalLinkSolidIcon size={16} aria-hidden="true" />
    </Button>
  )
}
