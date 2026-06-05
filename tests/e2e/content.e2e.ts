import { expect, test, type Page } from '@playwright/test'
import { ANONYMOUS_STATE, OWNER, login } from './helpers'

/**
 * CONTENT-001 / CONTENT-002 — create a post and confirm it persists, then
 * publish it and confirm the published state.
 */
test.describe('content', () => {
  test('creates a post that saves and persists (CONTENT-001)', async ({
    page,
  }) => {
    // Saving a draft does not step-up, so this runs on the shared owner state.
    const title = `E2E Post ${Date.now().toString(36)}`
    await createPostDraft(page, title, 'Body written by the automated content test.')

    await test.step('the post persists in the entry list after reload', async () => {
      await page.reload()
      await expect(entryRow(page, title)).toBeVisible()
    })
  })

  // Publishing triggers a step-up (rotates the session), so it runs fresh.
  test.describe('publishing', () => {
    test.use({ storageState: ANONYMOUS_STATE })

    test('publishes a post and shows the published state (CONTENT-002)', async ({
      page,
    }) => {
      await login(page)
      const title = `E2E Publish ${Date.now().toString(36)}`
      await createPostDraft(page, title, 'Body for the publish test.')

      await test.step('publish through the step-up prompt', async () => {
        await page.getByRole('button', { name: 'Publish post' }).click()

        const stepUp = page.getByTestId('step-up-dialog')
        if (await stepUp.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
          await page.getByTestId('step-up-password').fill(OWNER.password)
          await page.getByTestId('step-up-confirm').click()
          await expect(stepUp).toBeHidden({ timeout: 20_000 })
        }
      })

      // The publish action settles into a disabled "Published" button and the
      // entry's row reports the published status in the list.
      await expect(
        page.getByRole('button', { name: 'Published', exact: true }),
      ).toBeDisabled({ timeout: 20_000 })
      await expect(entryRow(page, title)).toContainText('published')
    })
  })
})

/**
 * Create a post draft with a title and body and save it, leaving it selected
 * and visible in the entry list. Assumes the user is logged in.
 */
async function createPostDraft(
  page: Page,
  title: string,
  body: string,
): Promise<void> {
  await page.goto('/admin/content')

  await test.step('create a new post', async () => {
    // The posts collection is selected by default; the New action enables once
    // it has loaded. `exact` avoids matching the canvas "New Post" CTA.
    const newPost = page.getByRole('button', { name: 'New post', exact: true })
    await expect(newPost).toBeEnabled()
    await newPost.click()

    await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title)
    await page.getByTestId('content-body-editor').click()
    await page.keyboard.type(body)
  })

  await test.step('save the draft', async () => {
    await page.getByRole('button', { name: 'More publishing actions' }).click()
    await page.getByTestId('toolbar-content-save-draft-action').click()
    // The new title replaces the "Untitled draft" placeholder once saved.
    await expect(entryRow(page, title)).toBeVisible({ timeout: 20_000 })
  })
}

/** The entry's row button in the content explorer list. */
function entryRow(page: Page, title: string) {
  return page.getByRole('button').filter({ hasText: title })
}
