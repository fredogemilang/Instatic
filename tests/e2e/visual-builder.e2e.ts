import { expect, test, type Page } from '@playwright/test'
import {
  ANONYMOUS_STATE,
  canvasFrame,
  createPage,
  insertModuleViaPicker,
  insertNotchModule,
  login,
  openLayersPanel,
  openSiteEditor,
  publishDraft,
  saveDraft,
  selectTreeLayer,
  setPropValue,
  visitPublicPage,
} from './helpers'

/**
 * BUILDER-001 / BUILDER-002 / EDIT-002 — insert modules, select a node, and
 * edit properties.
 *
 * Every test works on its own freshly-created page so module inserts never touch
 * the homepage or interfere with one another on the shared database.
 */
test.describe('visual builder', () => {
  test('inserts container, text, and image modules (BUILDER-001)', async ({
    page,
  }) => {
    await openBlankPage(page, 'Builder insert')

    await insertNotchModule(page, 'container')
    await insertNotchModule(page, 'text')
    await insertNotchModule(page, 'image')

    await openLayersPanel(page)
    const tree = page.getByRole('tree', { name: 'Page element tree' })
    await expect(tree.getByRole('treeitem', { name: 'Container' })).toBeVisible()
    await expect(tree.getByRole('treeitem', { name: 'Text' })).toBeVisible()
    await expect(tree.getByRole('treeitem', { name: 'Image' })).toBeVisible()
  })

  test('selects a node in the tree and edits its text (BUILDER-002)', async ({
    page,
  }) => {
    const headline = 'Selectable headline'
    const edited = 'Edited headline'

    await openBlankPage(page, 'Builder select')

    await insertNotchModule(page, 'text')
    await setPropValue(page, 'text', headline)
    await expect(canvasFrame(page).getByText(headline)).toBeVisible()

    // Insert a second module so selection moves away from the text node.
    await insertNotchModule(page, 'image')
    await expect(page.getByTestId('property-control-src')).toBeVisible()

    // Re-select the text node from the layers tree, then edit it again.
    await openLayersPanel(page)
    await selectTreeLayer(page, 'Text')
    await setPropValue(page, 'text', edited)
    await expect(canvasFrame(page).getByText(edited)).toBeVisible()
    await expect(canvasFrame(page).getByText(headline)).toHaveCount(0)
  })

  test('undoes and redoes an insert (BUILDER-005)', async ({ page }) => {
    await openBlankPage(page, 'Builder history')
    await openLayersPanel(page)
    const textNode = page
      .getByRole('tree', { name: 'Page element tree' })
      .getByRole('treeitem', { name: 'Text' })

    await insertNotchModule(page, 'text')
    await expect(textNode).toBeVisible()

    // Undo removes the inserted node; redo brings it back — one step each way.
    await page.getByTestId('canvas-notch-undo-btn').click()
    await expect(textNode).toHaveCount(0)
    await page.getByTestId('canvas-notch-redo-btn').click()
    await expect(textNode).toBeVisible()
  })

  // EDIT-002 publishes (step-up rotates the session), so it runs on a fresh login.
  test.describe('publishing', () => {
    test.use({ storageState: ANONYMOUS_STATE })

    test('adds a button with a label and link that publishes as an anchor (EDIT-002)', async ({
      page,
      browser,
    }) => {
      await login(page)
      const { slug } = await openBlankPage(page, 'Builder button')

      await insertModuleViaPicker(page, 'base.button')
      await setPropValue(page, 'label', 'Visit Example')
      await setPropValue(page, 'href', 'https://example.com')

      await saveDraft(page)
      await publishDraft(page)

      // The published button renders as a semantic anchor with the intended
      // label and href — verified on the visitor-facing page, the authoritative
      // output (the design canvas is a live preview, not the published HTML).
      await visitPublicPage(browser, {
        path: `/${slug}`,
        assert: async (visitor) => {
          const link = visitor.getByRole('link', { name: 'Visit Example' })
          await expect(link).toBeVisible()
          await expect(link).toHaveAttribute('href', /example\.com/)
        },
      })
    })
  })
})

/** Create a fresh page and open it in the canvas, ready for inserting modules. */
async function openBlankPage(
  page: Page,
  label: string,
): Promise<{ name: string; slug: string }> {
  await openSiteEditor(page)
  const suffix = Date.now().toString(36)
  const name = `${label} ${suffix}`
  const slug = `builder-${suffix}`
  await createPage(page, name, slug)
  const item = page.getByRole('treeitem', { name: `Open page ${name}` })
  await item.click()
  await expect(item).toHaveAttribute('aria-selected', 'true')
  return { name, slug }
}
