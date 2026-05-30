/**
 * Shared name→id linking utilities for HTML import operations.
 *
 * Extracted so both `insertImportedNodes` (single-page fragment insert) and
 * `mutateAllPagesAndSite` (whole-site Super Import) share the same canonical
 * algorithm without duplication.
 */

import { nanoid } from 'nanoid'
import { classKindSelector } from '@core/page-tree'
import type { StyleRule } from '@core/page-tree'

/**
 * Index a StyleRule registry by name → id.
 * First id wins on duplicates (createClass enforces name uniqueness, so
 * duplicates only occur in corrupted data — first-wins is a defensive tiebreak).
 */
export function indexStyleRulesByName(rules: Record<string, StyleRule>): Map<string, string> {
  const byName = new Map<string, string>()
  for (const cls of Object.values(rules)) {
    if (!byName.has(cls.name)) byName.set(cls.name, cls.id)
  }
  return byName
}

/**
 * Convert the class *names* an HTML importer stamped onto a fragment node
 * (`walkAndMap` copies `el.classList` verbatim) into real registry class *ids*.
 * A name that already names a class links to that class; an unknown name
 * auto-creates a bare (style-less) class so the token still renders and is
 * editable in the class panel.
 *
 * Mutates `rules` (adds new entries) and `byName` (caches them) so repeated
 * names across sibling nodes resolve to one shared class. Must run inside the
 * Immer producer that owns the `site` draft.
 */
export function linkImportedClassNames(
  classNames: readonly string[] | undefined,
  rules: Record<string, StyleRule>,
  byName: Map<string, string>,
): string[] {
  if (!classNames?.length) return []
  const ids: string[] = []
  for (const name of classNames) {
    if (name.length === 0) continue
    let id = byName.get(name)
    if (!id) {
      const now = Date.now()
      // Auto-created classes are always kind:'class' — they exist to back the
      // class-attribute tokens stamped onto imported nodes. Append at the
      // end of the cascade (`order` strictly greater than every existing
      // rule) so they don't accidentally outrank prior user-authored rules.
      let maxOrder = -1
      for (const c of Object.values(rules)) {
        if (typeof c.order === 'number' && c.order > maxOrder) maxOrder = c.order
      }
      const cls: StyleRule = {
        id: nanoid(),
        name,
        kind: 'class',
        selector: classKindSelector(name),
        order: maxOrder + 1,
        styles: {},
        contextStyles: {},
        createdAt: now,
        updatedAt: now,
      }
      rules[cls.id] = cls
      byName.set(name, cls.id)
      id = cls.id
    }
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}
