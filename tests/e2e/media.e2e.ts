import { expect, test, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  canvasFrame,
  createPage,
  insertNotchModule,
  login,
  openSiteEditor,
  publishDraft,
  saveDraft,
  visitPublicPage,
} from './helpers'

/** A minimal but valid 1×1 PNG — enough for the server's magic-byte check. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * MEDIA-001 / MEDIA-002 — upload an image and place it on a page, and confirm
 * that an unsupported upload is rejected with clear feedback.
 *
 * Fresh login per test: MEDIA-001 publishes, which rotates the session token, so
 * it must not run on the shared owner state.
 */
test.describe('media', () => {
  test.use({ storageState: ANONYMOUS_STATE })

  test('uploads an image, places it on a page, and publishes it (MEDIA-001)', async ({
    page,
    browser,
  }) => {
    const suffix = Date.now().toString(36)
    const slug = `media-${suffix}`
    const filename = `e2e-image-${suffix}.png`

    await login(page)
    await openSiteEditor(page)
    await createPage(page, `Media ${suffix}`, slug)
    await page.getByRole('treeitem', { name: `Open page Media ${suffix}` }).click()

    await insertNotchModule(page, 'image')
    await expect(page.getByTestId('property-control-src')).toBeVisible()

    await test.step('upload and select an image in the picker', async () => {
      await page.getByRole('button', { name: 'Browse image library' }).click()
      const picker = page.getByTestId('media-picker-modal')
      await expect(picker).toBeVisible()

      // The file input is hidden by design; set files on it directly rather
      // than driving the OS file chooser.
      await picker
        .locator('input[type="file"]')
        .setInputFiles({ name: filename, mimeType: 'image/png', buffer: PNG_1X1 })

      // Uploads are not auto-selected: pick the new asset, then confirm.
      await picker.getByRole('button', { name: `Open ${filename}` }).click()
      await picker.getByRole('button', { name: 'Use selected' }).click()
      await expect(picker).toBeHidden()
    })

    // The editor canvas previews the chosen asset from /uploads.
    await expect(
      canvasFrame(page).locator('img[src*="/uploads/"]').first(),
    ).toBeVisible()

    await saveDraft(page)
    await publishDraft(page)

    // The visitor-facing page serves the same uploaded image.
    await visitPublicPage(browser, {
      path: `/${slug}`,
      assert: async (visitor) => {
        await expect(
          visitor.locator('img[src*="/uploads/"]').first(),
        ).toBeVisible()
      },
    })
  })

  test('rejects an unsupported upload with clear feedback (MEDIA-002)', async ({
    page,
  }) => {
    await login(page)
    await page.goto('/admin/media')

    await uploadFile(page, {
      name: `not-an-image-${Date.now().toString(36)}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from('this is plainly not an image'),
    })

    // The server rejects unknown types by magic bytes; the queue surfaces the
    // specific reason, not a generic failure.
    await expect(page.getByRole('alert').filter({ hasText: /can be uploaded/ })).toBeVisible()
  })

  test('reuses a library asset on a second image without re-uploading (MEDIA-003)', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36)
    const filename = `reuse-${suffix}.png`

    await login(page)
    await openSiteEditor(page)
    await createPage(page, `Reuse ${suffix}`, `reuse-${suffix}`)
    await page.getByRole('treeitem', { name: `Open page Reuse ${suffix}` }).click()

    await test.step('upload the asset into the library on a first image', async () => {
      await insertNotchModule(page, 'image')
      await expect(page.getByTestId('property-control-src')).toBeVisible()
      await page.getByRole('button', { name: 'Browse image library' }).click()
      const picker = page.getByTestId('media-picker-modal')
      await picker
        .locator('input[type="file"]')
        .setInputFiles({ name: filename, mimeType: 'image/png', buffer: PNG_1X1 })
      await picker.getByRole('button', { name: `Open ${filename}` }).click()
      await picker.getByRole('button', { name: 'Use selected' }).click()
      await expect(picker).toBeHidden()
    })

    await test.step('place the same asset on a second image with no upload', async () => {
      await insertNotchModule(page, 'image')
      await page.getByRole('button', { name: 'Browse image library' }).click()
      const picker = page.getByTestId('media-picker-modal')
      // The asset is already in the library — selecting it proves reuse.
      const existing = picker.getByRole('button', { name: `Open ${filename}` })
      await expect(existing).toBeVisible()
      await existing.click()
      await picker.getByRole('button', { name: 'Use selected' }).click()
      await expect(picker).toBeHidden()
    })

    // Both image modules render the reused asset from /uploads.
    await expect(
      canvasFrame(page).locator('img[src*="/uploads/"]'),
    ).toHaveCount(2)
  })
})

async function uploadFile(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await expect(page.getByRole('button', { name: 'Upload media' })).toBeVisible()
  await page.locator('input[type="file"]').first().setInputFiles(file)
}
