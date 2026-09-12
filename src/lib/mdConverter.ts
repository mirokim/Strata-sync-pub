/**
 * MD Converter — generates Obsidian-compatible Markdown from text/metadata.
 * Used by ConverterModal (Feature 3).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConversionType = '회의록' | '보고서' | '기획서' | '기타'

export interface ConversionMeta {
  /** Document title (used as first H2 heading) */
  title: string
  /** Speaker / director ID string */
  speaker: string
  /** ISO date string YYYY-MM-DD */
  date: string
  /** Document type for frontmatter tag */
  type: ConversionType
}

// ── MD generation ─────────────────────────────────────────────────────────────

/**
 * Generate an Obsidian-compatible Markdown string from metadata and content.
 *
 * Output format:
 * ```
 * ---
 * speaker: art_director
 * date: 2026-02-27
 * tags: [회의록]
 * type: 회의록
 * ---
 *
 * ## 제목
 *
 * {content}
 * ```
 */
export function generateMD(meta: ConversionMeta, content: string): string {
  const safeTitle = meta.title.trim() || '문서'
  const safeSpeaker = meta.speaker || 'unknown'
  const safeDate = meta.date || new Date().toISOString().split('T')[0]

  const frontmatter = [
    '---',
    `speaker: ${safeSpeaker}`,
    `date: ${safeDate}`,
    `tags: [${meta.type}]`,
    `type: ${meta.type}`,
    '---',
  ].join('\n')

  const body = content.trim()

  return `${frontmatter}\n\n## ${safeTitle}\n\n${body}\n`
}

// ── File content extractors ───────────────────────────────────────────────────

/**
 * Text extraction from a DOCX file using JSZip.
 * Decompresses the ZIP, parses word/document.xml, extracts <w:t> elements.
 */
export async function extractDocxText(file: File): Promise<string> {
  const JSZip = (await import('jszip')).default
  const buffer = await file.arrayBuffer()
  let zip: InstanceType<typeof JSZip>
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    return ''
  }
  const xmlFile = zip.file('word/document.xml')
  if (!xmlFile) return ''
  const xml = await xmlFile.async('string')
  return (xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [])
    .map(m => m.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Text extraction from a PDF file using pdf.js.
 */
export async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist')
  // Worker는 Vite가 번들링한 경로 사용
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.mjs',
      import.meta.url,
    ).toString()
  }
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const parts: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items
      .filter((item): item is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in item)
      .map(item => item.str)
      .join(' ')
    if (pageText.trim()) parts.push(pageText)
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim()
}

/**
 * Best-effort text extraction from an HTML file.
 * Strips all HTML tags via DOMParser, leaving only the visible text content.
 */
export async function extractHtmlText(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const html = reader.result as string
        const parser = new DOMParser()
        const doc = parser.parseFromString(html, 'text/html')
        // Remove non-content elements
        doc.querySelectorAll('script, style, noscript, head').forEach(el => el.remove())
        const text = (doc.body?.innerText ?? doc.body?.textContent ?? '')
        resolve(text.replace(/\s+/g, ' ').trim())
      } catch {
        reject(new Error('HTML 파일 파싱 실패'))
      }
    }
    reader.onerror = () => reject(new Error('HTML 파일 읽기 실패'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * Read a file and return its text content.
 * Supports: .txt, .md (UTF-8 text), .html/.htm (tag-stripped), .docx (ZIP+XML best-effort), .pdf (best-effort).
 */
export async function readFileAsText(file: File): Promise<string> {
  const name = file.name.toLowerCase()

  if (name.endsWith('.txt') || name.endsWith('.md')) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('파일 읽기 실패'))
      reader.readAsText(file, 'utf-8')
    })
  }

  if (name.endsWith('.html') || name.endsWith('.htm')) return extractHtmlText(file)
  if (name.endsWith('.docx')) return extractDocxText(file)
  if (name.endsWith('.pdf')) return extractPdfText(file)

  throw new Error('지원하지 않는 파일 형식 (.txt .md .html .docx .pdf)')
}
