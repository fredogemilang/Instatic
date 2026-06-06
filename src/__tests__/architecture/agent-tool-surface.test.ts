/**
 * Architecture gate — AI site write-tool surface.
 *
 * Asserts that the legacy node-construction tools (`insertNode`,
 * `insertTree`) and the retired class-patch tools (`createClass`,
 * `updateClassStyles`) are absent from the registered site write-tool list,
 * and that the HTML-native replacements (`insertHtml`, `getNodeHtml`,
 * `replaceNodeHtml`) plus the single CSS-authoring tool (`applyCss`) are
 * present.
 *
 * This gate catches accidental re-introduction of the old tools and
 * ensures the agent has exactly the HTML-native surface it was redesigned
 * around.
 */

import { describe, it, expect } from 'bun:test'
import { siteWriteTools } from '../../../server/ai/tools/site/writeTools'

describe('agent-tool-surface gate', () => {
  const toolNames = siteWriteTools.map((t) => t.name)

  it('siteWriteTools array is non-empty', () => {
    expect(toolNames.length).toBeGreaterThan(0)
  })

  it('deprecated insertNode is absent', () => {
    expect(toolNames).not.toContain('insertNode')
  })

  it('deprecated insertTree is absent', () => {
    expect(toolNames).not.toContain('insertTree')
  })

  it('HTML-native insertHtml tool is present', () => {
    expect(toolNames).toContain('insertHtml')
  })

  it('HTML-native getNodeHtml tool is present', () => {
    expect(toolNames).toContain('getNodeHtml')
  })

  it('HTML-native replaceNodeHtml tool is present', () => {
    expect(toolNames).toContain('replaceNodeHtml')
  })

  it('single CSS-authoring applyCss tool is present', () => {
    expect(toolNames).toContain('applyCss')
  })

  it('retired class-patch tools are absent', () => {
    expect(toolNames).not.toContain('createClass')
    expect(toolNames).not.toContain('updateClassStyles')
  })

  it('design-system token tools are present', () => {
    expect(toolNames).toContain('set_color_tokens')
    expect(toolNames).toContain('set_font_tokens')
    expect(toolNames).toContain('set_type_scale')
    expect(toolNames).toContain('set_spacing_scale')
  })

  it('template tools are present', () => {
    expect(toolNames).toContain('setPageTemplate')
    expect(toolNames).toContain('clearPageTemplate')
  })

  it('total tool count is 22 (14 mutation + 2 template + 4 token + render_snapshot + getNodeHtml)', () => {
    expect(toolNames).toHaveLength(22)
  })
})
