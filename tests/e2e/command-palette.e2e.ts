import { expect, test, type Page } from '@playwright/test'
import { createPage, openSiteEditor } from './helpers'

/**
 * SPOT-001 / SPOT-002 / SPOT-004 / SPOT-006 — open and close the ⌘K command
 * palette, navigate to a workspace from it, run a destructive two-Enter confirm,
 * and see the empty state for a no-match query.
 *
 * Read-only/draft mutations, so these run on the shared owner state.
 */
const OPEN_KEY = process.platform === 'darwin' ? 'Meta+k' : 'Control+k'
test.describe('command palette', () => {
  test('opens with the shortcut and closes with Esc (SPOT-001)', async ({
    page,
  }) => {
    await page.goto('/admin/dashboard')

    const palette = await openPalette(page)
    await expect(input(page)).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    // Reopening yields a fresh palette with an empty query.
    await openPalette(page)
    await expect(input(page)).toHaveValue('')
  })

  test('navigates to a workspace from a query (SPOT-002)', async ({ page }) => {
    await page.goto('/admin/dashboard')

    await openPalette(page)
    await input(page).fill('go to content')

    // Run the workspace navigation command (not a content-entry deep link).
    await page.getByRole('option', { name: 'Go to Content', exact: true }).click()

    // The content workspace may auto-select an entry, appending a row query.
    await expect(page).toHaveURL(/\/admin\/content(\?|$)/)
    await expect(palette(page)).toBeHidden()
  })

  test('requires a two-Enter confirm for a destructive command (SPOT-004)', async ({
    page,
  }) => {
    const name = `Palette Delete ${Date.now().toString(36)}`

    // Create a throwaway page so "Delete current page" has a safe target that is
    // not the homepage; creating it makes it the active page.
    await openSiteEditor(page)
    await createPage(page, name, `palette-del-${Date.now().toString(36)}`)
    await page.getByRole('treeitem', { name: `Open page ${name}` }).click()

    await openPalette(page)
    await input(page).fill('delete current page')
    const deleteCommand = page.getByRole('option', {
      name: /Delete current page/,
    })
    await expect(deleteCommand).toBeVisible()

    // First Enter arms the confirm; it does not delete yet.
    await page.keyboard.press('Enter')
    await expect(palette(page).getByRole('alert')).toHaveText(/again to confirm/)
    await expect(
      page.getByRole('treeitem', { name: `Open page ${name}` }),
    ).toBeVisible()

    // Second Enter runs it: the palette closes and the page is gone.
    await page.keyboard.press('Enter')
    await expect(palette(page)).toBeHidden()
    await expect(
      page.getByRole('treeitem', { name: `Open page ${name}` }),
    ).toHaveCount(0)
  })

  test('shows an empty state for a no-match query (SPOT-006)', async ({
    page,
  }) => {
    await page.goto('/admin/dashboard')

    await openPalette(page)
    await input(page).fill('zzz-no-match-xkq')

    await expect(palette(page).getByText(/no results/i)).toBeVisible()
    await expect(page.getByRole('option')).toHaveCount(0)
  })

  // SPOT-003 (subcommand "Switch viewport") is intentionally NOT automated:
  // breakpointsScope.ts sources breakpoints via a Node-style require() that is
  // undefined in the browser bundle, so the scope is always empty ("No commands
  // available"). Tracked as a product bug; left to the agent-run audit.

  test('boosts a recently run command to the top on reopen (SPOT-008)', async ({
    page,
  }) => {
    await page.goto('/admin/dashboard')

    await openPalette(page)
    await input(page).fill('go to content')
    await page.getByRole('option', { name: 'Go to Content', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/content(\?|$)/)

    // Reopen with an empty query: recency boosts the just-run command to the top
    // of the list (it outranks the default first nav command, "Go to Site editor").
    await page.goto('/admin/dashboard')
    await openPalette(page)
    await expect(palette(page).getByRole('option').first()).toContainText(
      'Go to Content',
    )
  })
})

function palette(page: Page) {
  return page.getByRole('dialog', { name: 'Command palette' })
}

function input(page: Page) {
  return page.getByRole('combobox', { name: 'Search commands' })
}

async function openPalette(page: Page) {
  // Wait for the admin shell so the global ⌘K keydown listener has mounted
  // before pressing the shortcut.
  await expect(page.getByTestId('account-menu-trigger')).toBeVisible()
  const dialog = palette(page)
  await expect(async () => {
    await page.keyboard.press(OPEN_KEY)
    await expect(dialog).toBeVisible({ timeout: 1_000 })
  }).toPass()
  return dialog
}
