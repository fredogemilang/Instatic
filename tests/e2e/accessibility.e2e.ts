import { expect, test } from '@playwright/test'
import { ANONYMOUS_STATE, OWNER, expectLoggedIn } from './helpers'

/**
 * A11Y-001 and RESP-001 — keyboard-only login, and the admin editor at tablet
 * width. Lightweight smokes for focus order, keyboard submit, and responsive
 * layout; deeper accessibility and responsive review stays agent-run.
 */
test.describe('keyboard access', () => {
  // Logs in fresh, so it must not run on the shared owner state.
  test.use({ storageState: ANONYMOUS_STATE })

  test('logs in with the keyboard only (A11Y-001)', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'Admin Login' })).toBeVisible()

    const email = page.getByLabel('Email')
    await email.focus()
    await expect(email).toBeFocused()
    await page.keyboard.type(OWNER.email)

    // Tab advances to the password field (focus order), then Enter submits.
    await page.keyboard.press('Tab')
    await expect(page.getByLabel('Password')).toBeFocused()
    await page.keyboard.type(OWNER.password)
    await page.keyboard.press('Enter')

    await expectLoggedIn(page)
  })
})

test.describe('responsive', () => {
  test('admin editor is usable at tablet width (RESP-001)', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 })
    await page.goto('/admin/site')

    // Core editor chrome renders without the canvas collapsing at tablet width.
    await expect(page.getByTestId('toolbar')).toBeVisible()
    await expect(page.getByTestId('canvas-root')).toBeVisible()
    await expect(page.getByTestId('account-menu-trigger')).toBeVisible()
  })
})
