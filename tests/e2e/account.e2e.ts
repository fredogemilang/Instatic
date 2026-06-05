import { expect, test } from '@playwright/test'

/** A minimal but valid 1×1 PNG for the avatar upload. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * ADMIN-002 — change an account profile basic and confirm it persists.
 *
 * FINDING: the display name is not editable in the UI yet (ProfileTab renders it
 * read-only — "future work" per its own comment), so the editable profile basic
 * is the avatar. Display-name/email/password edit stay agent-run until built.
 */
test.describe('account', () => {
  test('uploads a profile picture that persists (ADMIN-002)', async ({ page }) => {
    await page.goto('/admin/account')
    await page.getByTestId('account-tab-profile').click()

    // The file input is hidden behind the upload button; set files on it directly.
    await page
      .getByTestId('profile-avatar-file')
      .setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: PNG_1X1 })
    await expect(page.getByTestId('profile-avatar-status')).toHaveText(/updated/i, {
      timeout: 20_000,
    })

    // After reload the avatar is still set — the Remove action is available.
    await page.reload()
    await page.getByTestId('account-tab-profile').click()
    await expect(page.getByTestId('profile-avatar-remove')).toBeVisible()
  })
})
