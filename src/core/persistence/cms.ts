import type { SiteDocument } from '../page-tree/types'
import type { IPersistenceAdapter } from './types'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import { responseErrorMessage } from './httpErrors'
import { CmsSiteEnvelopeSchema } from './responseSchemas'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

export class CmsAdapter implements IPersistenceAdapter {
  private readonly fetchImpl: FetchLike
  private readonly basePath: string

  constructor(
    fetchImpl: FetchLike = defaultFetch,
    basePath = '/api/cms',
  ) {
    this.fetchImpl = fetchImpl
    this.basePath = basePath
  }

  async saveSite(site: SiteDocument): Promise<void> {
    const res = await this.fetchImpl(`${this.basePath}/site`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site }),
    })
    if (!res.ok) {
      throw new Error(await responseErrorMessage(res, `CMS save failed with ${res.status}`))
    }
  }

  async loadSite(_id: string): Promise<SiteDocument | undefined> {
    const res = await this.fetchImpl(`${this.basePath}/site`, {
      method: 'GET',
      credentials: 'include',
    })
    if (res.status === 404) return undefined
    if (!res.ok) {
      throw new Error(await responseErrorMessage(res, `CMS load failed with ${res.status}`))
    }
    // Envelope validated; SiteDocument is too deep to schema here (separate
    // audit-types pass) — pass-through as unknown then cast back.
    const body = await parseJsonResponse(res, CmsSiteEnvelopeSchema)
    return body.site as SiteDocument | undefined
  }
}

export const cmsAdapter = new CmsAdapter()
