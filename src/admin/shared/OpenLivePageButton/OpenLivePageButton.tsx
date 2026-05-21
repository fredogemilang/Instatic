/**
 * OpenLivePageButton — toolbar icon that opens the live site in a new tab.
 *
 * Sits in the Toolbar's right cluster next to `AccountMenuButton`. Rendered
 * by `Toolbar.tsx` itself (not the layout-supplied `rightSlot`) so the button
 * appears on every admin route — Site editor, Content, Plugins, Users,
 * Account, plugin admin pages — with zero per-layout wiring.
 *
 * Target URL:
 *   - Site editor with an active page → that page's public slug
 *     (`pagePublicPath(slug)`).
 *   - Every other admin route → site root (`/`).
 *
 * The slug is read from `useAdminUi` (the tiny shared store) — NOT the
 * editor store — so this component is safe to mount on `AdminPageLayout`
 * without pulling the ~165 KB editor chunk into the non-editor bundle.
 * `AdminCanvasLayout` mirrors `selectActivePage(s)?.slug` into adminUi via
 * an effect on every render, and clears it on unmount; non-editor layouts
 * never write the field, so it naturally stays `null` outside the canvas.
 */
import { Button } from '@ui/components/Button'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { useAdminUi } from '@admin/state/adminUi'
import { pagePublicPath } from '@core/page-tree/slugs'

export function OpenLivePageButton() {
  const activePageSlug = useAdminUi((s) => s.activePageSlug)
  const target = activePageSlug ? pagePublicPath(activePageSlug) : '/'
  const tooltip = activePageSlug ? 'Open live page' : 'Open live site'

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
