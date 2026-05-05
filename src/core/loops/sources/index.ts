/**
 * Built-in loop sources self-register on import, mirroring how base
 * modules register in `src/modules/base/index.ts`.
 *
 * Imported once from `src/admin/AdminEntry.tsx` (admin chunk) and from
 * `server/cms/publicRenderer.ts` (server) so the registry is populated
 * before any loop renders.
 */

import { loopSourceRegistry } from '../registry'
import { ContentEntriesSource } from './contentEntries'
import { SitePagesSource } from './sitePages'
import { SiteMediaSource } from './siteMedia'

loopSourceRegistry.registerOrReplace(ContentEntriesSource)
loopSourceRegistry.registerOrReplace(SitePagesSource)
loopSourceRegistry.registerOrReplace(SiteMediaSource)
