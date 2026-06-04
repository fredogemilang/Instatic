import { describe, expect, it } from 'bun:test'
import { OutletModule } from '../index'

describe('base.outlet render', () => {
  it('emits an empty content region when no body is bound', () => {
    expect(OutletModule.render({ html: '' } as never).html).toBe('<article data-instatic-content-region></article>')
  })
  it('wraps bound body html in a content region', () => {
    expect(OutletModule.render({ html: '<p>hi</p>' } as never).html).toBe('<article data-instatic-content-region><p>hi</p></article>')
  })
})
