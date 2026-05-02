import type { CmsRuntimePreviewAsset, CmsRuntimePreviewResult } from '../../../core/persistence/cmsRuntime'

export interface MaterializedRuntimePreviewDocument {
  html: string
  revoke: () => void
}

export function materializeRuntimePreviewDocument(
  result: Pick<CmsRuntimePreviewResult, 'html' | 'assets'>,
): MaterializedRuntimePreviewDocument {
  const replacements = new Map<string, string>()

  for (const asset of result.assets) {
    replacements.set(asset.publicPath, createAssetDataUrl(asset))
  }

  let html = result.html
  for (const [publicPath, url] of replacements) {
    html = replaceAll(html, publicPath, url)
  }
  html = allowSandboxPreviewAssetUrls(html)

  return {
    html,
    revoke: () => {},
  }
}

function createAssetDataUrl(asset: CmsRuntimePreviewAsset): string {
  return `data:${asset.contentType},${encodeDataUrlContent(asset.content)}`
}

function encodeDataUrlContent(content: string): string {
  return encodeURIComponent(content).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function replaceAll(input: string, search: string, replacement: string): string {
  return input.split(search).join(replacement)
}

function allowSandboxPreviewAssetUrls(html: string): string {
  return html
    .replace(/script-src 'self'/g, "script-src 'self' data:")
    .replace(/style-src 'self' 'unsafe-inline'/g, "style-src 'self' 'unsafe-inline' data:")
}
