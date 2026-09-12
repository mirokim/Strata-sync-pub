/**
 * Confluence Storage Format → Obsidian Markdown 변환기
 *
 * Confluence REST API가 반환하는 body.storage.value (HTML+XHTML 혼합)를
 * 볼트 마크다운 형식으로 변환한다.
 *
 * 처리 항목:
 *  - 표준 HTML 태그 (h1-h6, p, ul/ol/li, strong/em, code, pre, table, a, br, hr)
 *  - Confluence 매크로 (ac:structured-macro[code], ac:link → [[wikilink]])
 *  - 볼트 frontmatter 자동 생성 (title, date, type, status, tags, confluence_id)
 *  - 정제 매뉴얼 v3.21 기준 품질 항목 자동 적용:
 *      HTML 잔재 제거, 연속 빈줄 축소, Frontmatter 필수 필드 보장
 */

// ── Raw page object shape returned by Confluence REST API ─────────────────────

export interface ConfluencePage {
  id: string
  title: string
  body: { storage: { value: string } }
  metadata?: { labels?: { results?: Array<{ name: string }> } }
  version?: { when?: string; number?: number }
  history?: { createdDate?: string; createdBy?: { displayName?: string } }
  _baseUrl?: string   // injected by import tab for source URL construction
}

// ── Frontmatter helpers ────────────────────────────────────────────────────────

/** Infer doc type from title / labels */
function inferType(title: string, labels: string[]): string {
  const t = title.toLowerCase()
  const l = labels.join(' ').toLowerCase()
  if (/회의|meeting|피드백|feedback/.test(t + l)) return 'meeting'
  if (/spec|기획|설계|design|사양/.test(t + l)) return 'spec'
  if (/가이드|guide|manual|매뉴얼/.test(t + l)) return 'guide'
  if (/decision|결정|ADR/.test(t + l)) return 'decision'
  return 'reference'
}

/** Sanitize a string for use as a filename stem */
export function toStem(title: string, confluenceId?: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]/g, '_')  // Windows/Unix forbidden chars
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 100)
  // Append short ID suffix (last 6 chars) to prevent title collision — same pattern as vault convention
  const suffix = confluenceId ? '_' + confluenceId.slice(-6) : ''
  return base + suffix
}

// ── HTML → Markdown (browser DOMParser based) ─────────────────────────────────

/**
 * Convert Confluence storage format HTML to plain Markdown.
 * Runs in the renderer process using the browser's DOMParser.
 */
export function confluenceHtmlToMarkdown(
  html: string,
  titleStemMap?: Map<string, string>,
): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  return nodeToMarkdown(doc.body, 0, titleStemMap).trim()
}

function nodeToMarkdown(node: Node, depth: number, titleStemMap?: Map<string, string>): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).data.replace(/\u00a0/g, ' ')  // &nbsp; → space
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return ''

  const el = node as Element
  const tag = el.tagName?.toLowerCase() ?? ''
  const children = () => Array.from(el.childNodes).map(c => nodeToMarkdown(c, depth, titleStemMap)).join('')

  switch (tag) {
    // ── Headings
    case 'h1': return `\n# ${children().trim()}\n`
    case 'h2': return `\n## ${children().trim()}\n`
    case 'h3': return `\n### ${children().trim()}\n`
    case 'h4': return `\n#### ${children().trim()}\n`
    case 'h5': return `\n##### ${children().trim()}\n`
    case 'h6': return `\n###### ${children().trim()}\n`

    // ── Paragraphs / block
    case 'p':  return `\n${children().trim()}\n`
    case 'br': return '\n'
    case 'hr': return '\n---\n'
    case 'div':
    case 'section':
    case 'article': return `\n${children()}\n`

    // ── Inline formatting
    case 'strong':
    case 'b': {
      const inner = children().trim()
      return inner ? `**${inner}**` : ''
    }
    case 'em':
    case 'i': {
      const inner = children().trim()
      return inner ? `*${inner}*` : ''
    }
    case 'u': {
      const inner = children().trim()
      return inner ? `<u>${inner}</u>` : ''
    }
    case 's':
    case 'del': {
      const inner = children().trim()
      return inner ? `~~${inner}~~` : ''
    }

    // ── Code
    case 'code': return `\`${el.textContent ?? ''}\``
    case 'pre': {
      // Confluence code macro renders inside <pre><code>
      const codeEl = el.querySelector('code')
      const lang = codeEl?.className?.replace('language-', '') ?? ''
      const text = (codeEl ?? el).textContent ?? ''
      return `\n\`\`\`${lang}\n${text}\n\`\`\`\n`
    }

    // ── Lists
    case 'ul': return `\n${listItems(el, depth, false, titleStemMap)}\n`
    case 'ol': return `\n${listItems(el, depth, true, titleStemMap)}\n`
    case 'li': return ''  // handled by listItems

    // ── Links
    case 'a': {
      const href = el.getAttribute('href') ?? ''
      const text = children().trim()
      if (!href) return text
      // javascript: / data: URL은 마크다운 링크로 변환하지 않고 텍스트만 반환
      const safeHref = /^(https?:|#|\/)/i.test(href) ? href : ''
      if (!safeHref) return text || href
      if (!text || text === href) return safeHref
      return `[${text}](${safeHref})`
    }

    // ── Images
    case 'img': {
      const alt = el.getAttribute('alt') ?? ''
      const src = el.getAttribute('src') ?? ''
      return src ? `![${alt}](${src})` : ''
    }

    // ── Tables
    case 'table': return `\n${tableToMd(el)}\n`
    case 'tbody':
    case 'thead':
    case 'tfoot': return children()
    case 'tr': return ''   // handled by tableToMd
    case 'th':
    case 'td': return ''   // handled by tableToMd

    // ── Blockquote
    case 'blockquote': {
      const lines = children().trim().split('\n').map(l => `> ${l}`).join('\n')
      return `\n${lines}\n`
    }

    // ── Confluence attachment image: ac:image → ![[filename]] (§4.1)
    // Attachments are downloaded in step 3 of ConfluenceTab pipeline, so ![[]] links are valid
    case 'ac:image': {
      const ri = el.querySelector('ri\\:attachment')
      const filename = ri?.getAttribute('ri:filename') ?? ''
      return filename ? `\n![[${filename}]]\n` : ''
    }

    // ── Confluence-specific: ac:structured-macro ───────────────────────────────
    case 'ac:structured-macro': {
      const macroName = el.getAttribute('ac:name') ?? ''

      if (macroName === 'code') {
        const langParam = el.querySelector('ac\\:parameter[ac\\:name="language"]')
        const lang = langParam?.textContent?.trim() ?? ''
        const body = el.querySelector('ac\\:plain-text-body')
        const code = body?.textContent ?? ''
        return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`
      }

      if (macroName === 'panel' || macroName === 'note' || macroName === 'warning' || macroName === 'info') {
        const titleParam = el.querySelector('ac\\:parameter[ac\\:name="title"]')
        const bodyEl = el.querySelector('ac\\:rich-text-body')
        const bodyText = bodyEl ? nodeToMarkdown(bodyEl, depth, titleStemMap).trim() : ''
        const header = titleParam?.textContent?.trim() ?? macroName
        const lines = bodyText.split('\n').map(l => `> ${l}`).join('\n')
        return `\n> **${header}**\n${lines}\n`
      }

      if (macroName === 'toc') return ''  // skip table-of-contents macros

      // Fallback: render children
      return children()
    }

    // ── Confluence link: ac:link → [[wikilink]]
    case 'ac:link': {
      const riPage = el.querySelector('ri\\:page')
      const pageTitle = riPage?.getAttribute('ri:content-title') ?? ''
      const displayEl = el.querySelector('ac\\:plain-text-link-body,ac\\:link-body')
      const display = displayEl?.textContent?.trim() ?? pageTitle
      if (!pageTitle) return display
      // Use pre-built stem map so links match actual filenames (with ID suffix)
      const stem = titleStemMap?.get(pageTitle) ?? toStem(pageTitle)
      return display && display !== pageTitle ? `[[${stem}|${display}]]` : `[[${stem}]]`
    }

    // ── Confluence rich-text body / plain-text body: recurse
    case 'ac:rich-text-body':
    case 'ac:plain-text-body':
    case 'ri:page':
    case 'ri:attachment':
      return children()

    // ── Confluence inline tasks — render as checkbox
    case 'ac:task': {
      const status = el.querySelector('ac\\:task-status')?.textContent?.trim()
      const body = el.querySelector('ac\\:task-body')?.textContent?.trim() ?? ''
      const check = status === 'complete' ? '[x]' : '[ ]'
      return `- ${check} ${body}\n`
    }

    // ── Skip layout/structural Confluence elements
    case 'ac:layout':
    case 'ac:layout-section':
    case 'ac:layout-cell':
      return `\n${children()}\n`

    default:
      return children()
  }
}

function listItems(el: Element, depth: number, ordered: boolean, titleStemMap?: Map<string, string>): string {
  const indent = '  '.repeat(depth)
  let idx = 1
  const lines: string[] = []
  for (const child of Array.from(el.children)) {
    if (child.tagName?.toLowerCase() !== 'li') continue
    const prefix = ordered ? `${idx++}.` : '-'
    // Nested list handling
    const nestedLists = Array.from(child.children).filter(c =>
      c.tagName?.toLowerCase() === 'ul' || c.tagName?.toLowerCase() === 'ol'
    )
    // Text content (without nested list children) — fix: correct operator precedence with extra parens
    const textParts = Array.from(child.childNodes)
      .filter(n => !((n.nodeType === Node.ELEMENT_NODE) &&
        ((n as Element).tagName?.toLowerCase() === 'ul' ||
         (n as Element).tagName?.toLowerCase() === 'ol')))
      .map(n => nodeToMarkdown(n, depth + 1, titleStemMap))
      .join('')
      .trim()
    lines.push(`${indent}${prefix} ${textParts}`)
    // Nested lists
    for (const nested of nestedLists) {
      const tag = nested.tagName.toLowerCase()
      lines.push(listItems(nested as Element, depth + 1, tag === 'ol', titleStemMap))
    }
  }
  return lines.join('\n')
}

function tableToMd(table: Element): string {
  // Collect direct rows only (avoid descending into nested tables)
  const rows: Element[] = []
  for (const child of Array.from(table.children)) {
    const tag = child.tagName?.toLowerCase()
    if (tag === 'tr') rows.push(child)
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      for (const row of Array.from(child.children)) {
        if (row.tagName?.toLowerCase() === 'tr') rows.push(row)
      }
    }
  }
  if (rows.length === 0) return ''

  const toRow = (row: Element): string[] =>
    Array.from(row.querySelectorAll('th,td')).map(cell =>
      nodeToMarkdown(cell, 0).replace(/\n/g, ' ').trim()
    )

  const header = toRow(rows[0])
  const separator = header.map(() => '---')
  const body = rows.slice(1).map(toRow)

  const fmt = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [fmt(header), fmt(separator), ...body.map(fmt)].join('\n')
}

// ── Full page → vault markdown (frontmatter + body) ───────────────────────────

export interface VaultPage {
  /** Safe filename stem (spaces replaced with underscores) */
  stem: string
  /** Filename including .md extension */
  filename: string
  /** Full markdown content with frontmatter */
  content: string
}

export function pageToVaultMarkdown(page: ConfluencePage, titleStemMap?: Map<string, string>): VaultPage {
  const labels = page.metadata?.labels?.results?.map(l => l.name) ?? []
  // 매뉴얼 §4.0: "파일 수정일 우선" — version.when(최종 수정일) > history.createdDate(생성일)
  const dateStr =
    page.version?.when?.slice(0, 10) ??
    page.history?.createdDate?.slice(0, 10) ??
    new Date().toISOString().slice(0, 10)
  const docType = inferType(page.title, labels)
  // Append ID suffix to prevent title collision (매뉴얼 v3.0 파일명 규칙)
  const stem = toStem(page.title, page.id)

  // Source URL (매뉴얼 6.1 — source 필드)
  const sourceUrl = page._baseUrl
    ? `${page._baseUrl.replace(/\/+$/, '')}/wiki/pages/viewpage.action?pageId=${page.id}`
    : ''

  // Frontmatter (매뉴얼 6.1 필수 필드: date/type/status/tags + source/origin)
  const tagYaml = labels.length ? `[${labels.map(l => `"${l}"`).join(', ')}]` : '[]'
  const frontmatterLines = [
    '---',
    `title: "${page.title.replace(/"/g, "'")}"`,
    `date: ${dateStr}`,
    `type: ${docType}`,
    `status: active`,
    `tags: ${tagYaml}`,
    `origin: confluence`,
    `confluence_id: "${page.id}"`,
    `graph_weight: normal`,
  ]
  frontmatterLines.push(sourceUrl ? `source: "${sourceUrl}"` : 'source: "generated"')
  frontmatterLines.push('---', '')
  const frontmatter = frontmatterLines.join('\n')

  // Body
  const rawHtml = page.body?.storage?.value ?? ''
  let body = confluenceHtmlToMarkdown(rawHtml, titleStemMap)

  // Post-processing (정제 매뉴얼 v3.0 기준)
  // ① 연속 빈줄 3개 이상 → 2개로 축소 (audit_and_fix \n{4,} 기준)
  body = body.replace(/\n{4,}/g, '\n\n')
  // ② 삼중 이상 대괄호 수정: [[[...]] 또는 [[[...]]] → [[...]] (audit_and_fix FIX-2)
  body = body.replace(/\[{3,}([^\[\]]+?)\]{2,}/g, '[[$1]]')
  // ③ 줄 끝 공백 제거
  body = body.split('\n').map(l => l.trimEnd()).join('\n')

  return {
    stem,
    filename: `${stem}.md`,
    content: frontmatter + body.trim() + '\n',
  }
}
