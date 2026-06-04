import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TemplateSettingsDialog, type TemplateSettingsPayload } from '@admin/shared/dialogs/TemplateSettingsDialog/TemplateSettingsDialog'
import type { Page } from '@core/page-tree'

afterEach(cleanup)

const node = (id: string, moduleId: string, children: string[] = []) =>
  ({ id, moduleId, props: {}, breakpointOverrides: {}, children })

const pageWith = (outletCount: number): Page => {
  const outletIds = Array.from({ length: outletCount }, (_, i) => `o${i}`)
  const nodes: Record<string, unknown> = {
    body: node('body', 'base.body', outletIds),
  }
  for (const id of outletIds) nodes[id] = node(id, 'base.outlet')
  return { id: 'p1', slug: 'tpl', title: 'Tpl', rootNodeId: 'body', nodes } as unknown as Page
}

function submit() {
  const form = document.getElementById('template-settings-form') as HTMLFormElement
  fireEvent.submit(form)
}

describe('TemplateSettingsDialog', () => {
  it('saves an everywhere target with no conditions key', () => {
    let saved: TemplateSettingsPayload | null = null
    render(
      <TemplateSettingsDialog
        page={pageWith(1)}
        pages={[pageWith(1)]}
        onCancel={() => {}}
        onSave={(p) => { saved = p }}
      />,
    )
    submit()
    expect(saved).not.toBeNull()
    expect(saved!.template.target).toEqual({ kind: 'everywhere' })
    expect('conditions' in saved!.template).toBe(false)
  })

  it('saves a postTypes target with the checked slugs', () => {
    let saved: TemplateSettingsPayload | null = null
    render(
      <TemplateSettingsDialog
        page={pageWith(1)}
        pages={[pageWith(1)]}
        onCancel={() => {}}
        onSave={(p) => { saved = p }}
      />,
    )
    // Switch "Applies to" from Everywhere → Post types via keyboard.
    const combobox = screen.getByRole('combobox', { name: /applies to/i })
    combobox.focus()
    // First ArrowDown opens the listbox (highlight stays on the current value);
    // the second moves to "Post types"; Enter commits.
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'Enter' })

    // Check the fallback Posts post type.
    const postsCheckbox = screen.getByRole('checkbox', { name: /posts/i })
    fireEvent.click(postsCheckbox)

    submit()
    expect(saved).not.toBeNull()
    expect(saved!.template.target).toEqual({ kind: 'postTypes', tableSlugs: ['posts'] })
  })

  it('blocks save and shows an alert when the tree has zero outlets', () => {
    let saved: TemplateSettingsPayload | null = null
    render(
      <TemplateSettingsDialog
        page={pageWith(0)}
        pages={[pageWith(0)]}
        onCancel={() => {}}
        onSave={(p) => { saved = p }}
      />,
    )
    expect(screen.getByRole('alert').textContent).toMatch(/Content Outlet/i)
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    submit()
    expect(saved).toBeNull()
  })
})
