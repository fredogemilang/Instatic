export interface RenderContentDocumentInput {
  title: string
  bodyMarkdown: string
  seoTitle: string
  seoDescription: string
  featuredMediaPath: string | null
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/
const VIDEO_RE = /^@\[video\]\(([^)]+)\)$/
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeUrl(value: string): string {
  const trimmed = value.trim()
  if (/^(https?:|mailto:)/i.test(trimmed) || trimmed.startsWith('/')) {
    return escapeHtml(trimmed)
  }
  return '#'
}

function renderInlineMarkdown(value: string): string {
  return escapeHtml(value).replace(LINK_RE, (_match, label: string, href: string) => {
    const safeHref = safeUrl(href)
    const safeLabel = escapeHtml(label)
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`
  })
}

export function renderContentMarkdown(markdown: string): string {
  const blocks: string[] = []
  const paragraphLines: string[] = []

  function flushParagraph() {
    if (paragraphLines.length === 0) return
    blocks.push(`<p>${renderInlineMarkdown(paragraphLines.join(' '))}</p>`)
    paragraphLines.length = 0
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      flushParagraph()
      continue
    }

    const image = line.match(IMAGE_RE)
    if (image) {
      flushParagraph()
      blocks.push(`<img src="${safeUrl(image[2])}" alt="${escapeHtml(image[1])}" loading="lazy">`)
      continue
    }

    const video = line.match(VIDEO_RE)
    if (video) {
      flushParagraph()
      blocks.push(`<video controls src="${safeUrl(video[1])}"></video>`)
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      flushParagraph()
      const level = heading[1].length
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`)
      continue
    }

    paragraphLines.push(line)
  }

  flushParagraph()
  return blocks.join('\n')
}

export function renderContentDocumentHtml(input: RenderContentDocumentInput): string {
  const title = escapeHtml(input.title || 'Untitled')
  const seoTitle = escapeHtml(input.seoTitle || input.title || 'Untitled')
  const seoDescription = escapeHtml(input.seoDescription || '')
  const bodyHtml = renderContentMarkdown(input.bodyMarkdown)
  const featuredMedia = input.featuredMediaPath
    ? `<img class="featured-media" src="${safeUrl(input.featuredMediaPath)}" alt="" loading="lazy">`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${seoTitle}</title>
  ${seoDescription ? `<meta name="description" content="${seoDescription}">` : ''}
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #f7f7f5; color: #141414; }
    main { width: min(760px, calc(100vw - 40px)); margin: 0 auto; padding: 72px 0 96px; }
    h1 { margin: 0 0 24px; font-size: clamp(40px, 7vw, 72px); line-height: .95; letter-spacing: 0; }
    .featured-media { display: block; width: 100%; margin: 0 0 32px; border-radius: 8px; object-fit: cover; }
    article { font-size: 18px; line-height: 1.72; }
    article h1, article h2, article h3 { margin: 1.5em 0 .5em; line-height: 1.15; letter-spacing: 0; }
    article h1 { font-size: 40px; }
    article h2 { font-size: 30px; }
    article h3 { font-size: 24px; }
    article p { margin: 0 0 1.1em; }
    article a { color: #3346d3; }
    article img, article video { display: block; max-width: 100%; margin: 28px 0; border-radius: 8px; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    ${featuredMedia}
    <article>${bodyHtml}</article>
  </main>
</body>
</html>`
}
