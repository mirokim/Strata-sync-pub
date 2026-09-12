/**
 * jiraToMarkdown.ts — Jira issue → Obsidian vault markdown
 */

export interface JiraIssue {
  id: string
  key: string
  fields: Record<string, any>
}

export interface VaultIssue {
  filename: string
  content: string
  key: string
  summary: string
  type: string
  status: string
  date: string
}

/** Convert Jira wiki markup / Atlassian Document Format to markdown */
function jiraBodyToMarkdown(body: any): string {
  if (!body) return ''
  // ADF (Atlassian Document Format - Cloud v3)
  if (body && typeof body === 'object' && body.type === 'doc') {
    return adfToMarkdown(body)
  }
  // Plain string (Server v2 wiki markup)
  if (typeof body === 'string') {
    return wikiToMarkdown(body)
  }
  return ''
}

function adfToMarkdown(node: any): string {
  if (!node) return ''
  switch (node.type) {
    case 'doc': return (node.content ?? []).map(adfToMarkdown).join('\n')
    case 'paragraph': return (node.content ?? []).map(adfToMarkdown).join('') + '\n'
    case 'text': {
      let t = node.text ?? ''
      const marks = node.marks ?? []
      for (const m of marks) {
        if (m.type === 'strong') t = `**${t}**`
        else if (m.type === 'em') t = `*${t}*`
        else if (m.type === 'code') t = `\`${t}\``
        else if (m.type === 'link') t = `[${t}](${m.attrs?.href ?? ''})`
        else if (m.type === 'strike') t = `~~${t}~~`
      }
      return t
    }
    case 'heading': {
      const level = node.attrs?.level ?? 1
      const text = (node.content ?? []).map(adfToMarkdown).join('')
      return '#'.repeat(level) + ' ' + text + '\n'
    }
    case 'bulletList': return (node.content ?? []).map(adfToMarkdown).join('')
    case 'orderedList': {
      let i = 1
      return (node.content ?? []).map((item: any) => {
        const text = adfToMarkdown(item).replace(/^- /, `${i++}. `)
        return text
      }).join('')
    }
    case 'listItem': return '- ' + (node.content ?? []).map(adfToMarkdown).join('').trim() + '\n'
    case 'codeBlock': {
      const lang = node.attrs?.language ?? ''
      const code = (node.content ?? []).map((n: any) => n.text ?? '').join('')
      return `\`\`\`${lang}\n${code}\n\`\`\`\n`
    }
    case 'blockquote': return (node.content ?? []).map(adfToMarkdown).map((l: string) => '> ' + l).join('')
    case 'rule': return '\n---\n'
    case 'hardBreak': return '\n'
    case 'mention': return `@${node.attrs?.text ?? ''}`
    case 'inlineCard':
    case 'blockCard': return node.attrs?.url ? `[링크](${node.attrs.url})` : ''
    case 'table': return (node.content ?? []).map(adfToMarkdown).join('') + '\n'
    case 'tableRow': return '| ' + (node.content ?? []).map((cell: any) => adfToMarkdown(cell).replace(/\n/g, ' ').trim()).join(' | ') + ' |\n'
    case 'tableHeader':
    case 'tableCell': return (node.content ?? []).map(adfToMarkdown).join('').trim()
    default: return (node.content ?? []).map(adfToMarkdown).join('')
  }
}

function wikiToMarkdown(wiki: string): string {
  return wiki
    .replace(/\{code(?::([^}]+))?\}([\s\S]*?)\{code\}/g, '```$1\n$2\n```')
    .replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, '```\n$1\n```')
    .replace(/\{quote\}([\s\S]*?)\{quote\}/g, (_, c) => c.split('\n').map((l: string) => '> ' + l).join('\n'))
    .replace(/h([1-6])\. (.+)/g, (_, n, t) => '#'.repeat(Number(n)) + ' ' + t)
    .replace(/\*([^*\n]+)\*/g, '**$1**')
    .replace(/_([^_\n]+)_/g, '*$1*')
    .replace(/\?\?([^?\n]+)\?\?/g, '<cite>$1</cite>')
    .replace(/-([^-\n]+)-/g, '~~$1~~')
    .replace(/\+([^+\n]+)\+/g, '<u>$1</u>')
    .replace(/\[([^\|]+)\|([^\]]+)\]/g, '[$1]($2)')
    .replace(/\[([^\]]+)\]/g, '[$1]($1)')
    .replace(/^\* /gm, '- ')
    .replace(/^\*{2} /gm, '  - ')
    .replace(/^# /gm, '1. ')
    .trim()
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
}

/** Map Jira issue type → v3.6 manual type taxonomy */
function inferDocType(issueType: string): string {
  const t = issueType.toLowerCase()
  if (/meeting|회의|retrospective|retro/.test(t)) return 'meeting'
  if (/decision|adr|결정/.test(t)) return 'decision'
  if (/guide|manual|매뉴얼|가이드|onboarding|온보딩/.test(t)) return 'guide'
  // Bug, Story, Task, Epic, Sub-task → spec
  return 'spec'
}

/** Map Jira status → v3.6 vault status */
function inferVaultStatus(jiraStatus: string): string {
  const s = jiraStatus.toLowerCase()
  if (/done|closed|resolved|완료|종료/.test(s)) return 'outdated'
  if (/cancelled|canceled|취소|wont.?fix/.test(s)) return 'deprecated'
  return 'active'
}

export function issueToVaultMarkdown(issue: JiraIssue, baseUrl?: string): VaultIssue {
  const f = issue.fields
  const key = issue.key
  const summary = f.summary ?? '제목 없음'
  const jiraStatus = f.status?.name ?? ''
  const priority = f.priority?.name ?? ''
  const issueType = f.issuetype?.name ?? ''
  const assignee = f.assignee?.displayName ?? ''
  const reporter = f.reporter?.displayName ?? ''
  const created = (f.created ?? '').slice(0, 10)
  const updated = (f.updated ?? '').slice(0, 10)
  const labels: string[] = f.labels ?? []
  const components: string[] = (f.components ?? []).map((c: any) => c.name)
  const fixVersions: string[] = (f.fixVersions ?? []).map((v: any) => v.name)
  const storyPoints = f.customfield_10016

  // v3.6: doc type + vault status
  const docType = inferDocType(issueType)
  const vaultStatus = inferVaultStatus(jiraStatus)

  // v3.6: source URL
  const sourceUrl = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/browse/${key}` : ''

  const descriptionMd = jiraBodyToMarkdown(f.description)

  const comments: string[] = (f.comment?.comments ?? []).map((c: any) => {
    const author = c.author?.displayName ?? '알 수 없음'
    const date = (c.created ?? '').slice(0, 10)
    const body = jiraBodyToMarkdown(c.body)
    return `### ${author} (${date})\n\n${body}`
  })

  const tagsList = ['jira', issueType.toLowerCase(), ...labels].filter(Boolean)
  const filename = sanitizeFilename(`${key} ${summary}.md`)

  const lines: string[] = [
    '---',
    `title: "${key} ${summary.replace(/"/g, "'")}"`,
    `jira_key: ${key}`,
    `type: ${docType}`,
    `status: ${vaultStatus}`,
    `origin: jira`,
    sourceUrl ? `source: "${sourceUrl}"` : '',
    priority ? `priority: ${priority}` : '',
    assignee ? `assignee: ${assignee}` : '',
    reporter ? `reporter: ${reporter}` : '',
    `date: ${updated || created}`,
    `created: ${created}`,
    components.length ? `components: [${components.join(', ')}]` : '',
    fixVersions.length ? `fix_versions: [${fixVersions.join(', ')}]` : '',
    storyPoints != null ? `story_points: ${storyPoints}` : '',
    tagsList.length ? `tags: [${tagsList.join(', ')}]` : '',
    '---',
    '',
    `# [${key}] ${summary}`,
    '',
    `| 항목 | 값 |`,
    `|------|-----|`,
    `| 유형 | ${issueType} |`,
    `| 상태 | ${status} |`,
    priority ? `| 우선순위 | ${priority} |` : '',
    assignee ? `| 담당자 | ${assignee} |` : '',
    reporter ? `| 보고자 | ${reporter} |` : '',
    storyPoints != null ? `| 스토리 포인트 | ${storyPoints} |` : '',
    components.length ? `| 컴포넌트 | ${components.join(', ')} |` : '',
    fixVersions.length ? `| 버전 | ${fixVersions.join(', ')} |` : '',
    '',
  ].filter(l => l !== null && l !== undefined)

  if (descriptionMd.trim()) {
    lines.push('## 설명', '', descriptionMd.trim(), '')
  }

  if (comments.length > 0) {
    lines.push('## 댓글', '', ...comments.flatMap(c => [c, '']), '')
  }

  const content = lines.join('\n')

  return {
    filename,
    content,
    key,
    summary,
    type: docType,
    status: vaultStatus,
    date: updated || created,
  }
}
