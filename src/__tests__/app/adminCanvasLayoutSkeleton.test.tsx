import { describe, expect, it } from 'bun:test'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { AdminCanvasLayoutSkeleton } from '@admin/layouts/AdminCanvasLayout/AdminCanvasLayout'

describe('AdminCanvasLayoutSkeleton', () => {
  it('renders the site editor shell regions while the site document loads', () => {
    render(<AdminCanvasLayoutSkeleton />)

    expect(screen.getByRole('status', { name: 'Loading site editor' })).toBeDefined()
    expect(screen.getByTestId('admin-site-loading-toolbar')).toBeDefined()
    expect(screen.getByTestId('admin-site-loading-left-panel')).toBeDefined()
    expect(screen.getByTestId('admin-site-loading-canvas')).toBeDefined()
    expect(screen.getByTestId('admin-site-loading-right-panel')).toBeDefined()
  })
})
