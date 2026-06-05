import { expect, test, type Page } from '@playwright/test'
import { expectEditorReady } from './helpers'

/**
 * ADMIN-001 — move between the primary admin workspaces and confirm the active
 * workspace is unambiguous.
 *
 * The section nav lives in the toolbar banner. The active workspace renders as a
 * non-clickable `<span>` while the others stay links, so "active" is asserted by
 * the section's link disappearing from the toolbar (plus the URL). Account is
 * reached through the account menu rather than the section nav.
 *
 * Read-only navigation — runs as the owner via the shared auth state.
 */
test.describe('admin navigation', () => {
  test('moves between Site, Content, Plugins, Users, and Account', async ({
    page,
  }) => {
    await page.goto('/admin/site')
    await expectEditorReady(page)
    await expectActiveSection(page, 'Site')

    await navigateSection(page, 'Content', '/admin/content')
    await navigateSection(page, 'Plugins', '/admin/plugins')
    await navigateSection(page, 'Users', '/admin/users')

    await test.step('reach Account from the account menu', async () => {
      await page.getByTestId('account-menu-trigger').click()
      await page.getByTestId('account-menu-go-to-account').click()
      await expect(page).toHaveURL(/\/admin\/account$/)
      await expect(page.getByRole('tab', { name: 'Profile' })).toBeVisible()
    })
  })
})

/** Click a section link in the toolbar and confirm the workspace took over. */
async function navigateSection(
  page: Page,
  name: string,
  path: string,
): Promise<void> {
  await test.step(`navigate to ${name}`, async () => {
    await page.getByTestId('toolbar').getByRole('link', { name }).click()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    await expectActiveSection(page, name)
  })
}

/** The active section is the only nav item rendered as text instead of a link. */
async function expectActiveSection(page: Page, name: string): Promise<void> {
  const toolbar = page.getByTestId('toolbar')
  await expect(toolbar.getByRole('link', { name })).toHaveCount(0)
  await expect(toolbar.getByText(name, { exact: true })).toBeVisible()
}
