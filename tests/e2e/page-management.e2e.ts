import { expect, test, type Locator } from '@playwright/test'
import { createPage, openSiteEditor } from './helpers'

/**
 * PAGE-001 / PAGE-002 — create a page, then rename and open it.
 *
 * Each test creates its own uniquely-named pages in the Site Explorer, so it
 * never collides with the homepage (owned by the core lifecycle spec) or with a
 * reused database from a previous run.
 */
test.describe('page management', () => {
  test('creates a new page and opens it in the canvas (PAGE-001)', async ({
    page,
  }) => {
    const name = uniqueName('About')
    const slug = uniqueSlug('about')

    await openSiteEditor(page)
    await createPage(page, name, slug)

    // The new page is in the tree and opens in the canvas when selected.
    await openPage(page.getByRole('treeitem', { name: `Open page ${name}` }))
  })

  test('deletes a page from the explorer (PAGE-003)', async ({ page }) => {
    // FINDING: single-page delete in the explorer is immediate — there is no
    // confirm dialog (only *bulk* delete and the ⌘K "Delete current page"
    // command confirm; the latter is covered by SPOT-004). This asserts the
    // delete mechanics and the page leaving the tree.
    const name = uniqueName('Disposable')

    await openSiteEditor(page)
    await createPage(page, name, uniqueSlug('disposable'))
    const item = page.getByRole('treeitem', { name: `Open page ${name}` })

    await item.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete' }).click()

    await expect(item).toHaveCount(0)
  })

  test('renames a page and opens it under the new name (PAGE-002)', async ({
    page,
  }) => {
    const original = uniqueName('Pricing')
    const renamed = uniqueName('Plans')
    const slug = uniqueSlug('pricing')

    await openSiteEditor(page)
    await createPage(page, original, slug)

    await test.step('rename via the context menu', async () => {
      await page
        .getByRole('treeitem', { name: `Open page ${original}` })
        .click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Rename' }).click()

      const renameInput = page.getByRole('textbox', {
        name: `Rename ${original}`,
      })
      await renameInput.fill(renamed)
      await renameInput.press('Enter')
    })

    await test.step('the renamed page is openable and the old name is gone', async () => {
      const renamedItem = page.getByRole('treeitem', {
        name: `Open page ${renamed}`,
      })
      await expect(renamedItem).toBeVisible()
      await expect(
        page.getByRole('treeitem', { name: `Open page ${original}` }),
      ).toHaveCount(0)

      await openPage(renamedItem)
    })
  })
})

async function openPage(item: Locator): Promise<void> {
  await item.click()
  await expect(item).toHaveAttribute('aria-selected', 'true')
}

function uniqueName(base: string): string {
  return `${base} ${Date.now().toString(36)}`
}

function uniqueSlug(base: string): string {
  return `${base}-${Date.now().toString(36)}`
}
