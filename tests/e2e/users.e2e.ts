import { expect, test, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, completeStepUp, login, loginAs } from './helpers'

/**
 * ADMIN-004 / CAP-001 — owner creates a non-owner user, and a capability-limited
 * user only reaches the workspaces its role grants.
 *
 * Creating users and roles always triggers a step-up (rotating the session), so
 * these run on a fresh owner login rather than the shared state.
 */
test.describe('users and roles', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('owner creates a non-owner user (ADMIN-004)', async ({ page }) => {
    await login(page)
    const email = `member-${Date.now().toString(36)}@example.com`

    await page.goto('/admin/users')
    await createUser(page, {
      email,
      displayName: 'E2E Member',
      password: 'member-pass-12345',
      role: 'Member',
    })

    await expect(page.getByText(email)).toBeVisible()
  })

  test('a limited user only reaches granted workspaces (CAP-001)', async ({
    page,
    browser,
  }) => {
    await login(page)
    const suffix = Date.now().toString(36)
    const roleName = `Limited ${suffix}`
    const email = `limited-${suffix}@example.com`
    const password = 'limited-pass-12345'

    await createSiteAndMediaRole(page, roleName)
    // Reload so the freshly created role is selectable in the user dialog.
    await page.goto('/admin/users')
    await createUser(page, {
      email,
      displayName: 'Limited User',
      password,
      role: roleName,
    })

    await test.step('the limited user sees only Site and Media, not Users/Content', async () => {
      const context = await browser.newContext()
      const limited = await context.newPage()
      try {
        await loginAs(limited, email, password)
        const toolbar = limited.getByTestId('toolbar')

        // Media is granted (a reachable link); Content and Users are not in the
        // nav at all (no link, no active label).
        await expect(toolbar.getByRole('link', { name: 'Media' })).toBeVisible()
        await expect(toolbar.getByText('Content', { exact: true })).toHaveCount(0)
        await expect(toolbar.getByText('Users', { exact: true })).toHaveCount(0)

        // A direct URL to a denied workspace must not render it — the guard
        // redirects away from /admin/users.
        await limited.goto('/admin/users')
        await expect(limited).not.toHaveURL(/\/admin\/users/)
        await expect(
          limited.getByRole('heading', { name: 'All Users' }),
        ).toHaveCount(0)
      } finally {
        await context.close()
      }
    })
  })
})

async function createUser(
  page: Page,
  user: { email: string; displayName: string; password: string; role: string },
): Promise<void> {
  await page.getByRole('button', { name: 'Create User', exact: true }).click()
  await page.locator('input[name="new-user-email-address"]').fill(user.email)
  await page.locator('input[name="new-user-display-name"]').fill(user.displayName)
  await page.locator('input[name="new-user-initial-password"]').fill(user.password)
  await page.locator('select[name="new-user-role"]').selectOption({ label: user.role })
  await page.locator('button[form="users-page-user-form"]').click()
  await completeStepUp(page)
}

/** Create a custom role granting only Site (read) and Media (read). */
async function createSiteAndMediaRole(page: Page, name: string): Promise<void> {
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Roles', exact: true }).click()
  await page.getByRole('button', { name: 'Create Role', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Create Role' })
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  // Each capability is a labelled checkbox — clicking the label text toggles it.
  await dialog.getByText('View site', { exact: true }).click()
  await dialog.getByText('Browse media library', { exact: true }).click()

  await page.locator('button[form="users-page-role-form"]').click()
  await completeStepUp(page)
}
