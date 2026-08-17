import fs from 'fs'
import path from 'path'

export type LearnItem = {
  slug: string
  title: string
  description: string
  content: string
}

function parseFrontmatter(raw: string): { title?: string; body: string } {
  if (!raw.startsWith('---')) return { body: raw }
  const end = raw.indexOf('---', 3)
  if (end === -1) return { body: raw }
  const frontmatter = raw.slice(3, end)
  const body = raw.slice(end + 3).trim()
  const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m)
  return { title: titleMatch?.[1], body }
}

function extractTitle(slug: string, body: string): string {
  const headingMatch = body.match(/^#\s+(.+)$/m)
  return headingMatch?.[1] ?? slug
}

function extractDescription(body: string): string {
  const lines = body.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    if (trimmed.startsWith('|')) continue
    if (trimmed.startsWith('```')) continue
    if (trimmed.startsWith('>')) continue
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) continue
    return trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed
  }
  return ''
}

function loadMarkdownDir(dirPath: string): LearnItem[] {
  if (!fs.existsSync(dirPath)) return []
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'))
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(dirPath, file), 'utf-8')
    const slug = file.replace(/\.md$/, '')
    const { title: fmTitle, body } = parseFrontmatter(raw)
    const title = fmTitle ?? extractTitle(slug, body)
    const description = extractDescription(body)
    return { slug, title, description, content: body }
  })
}

const DOCKER_CONTENT = '/learn-content'
const ROOT = path.resolve(process.cwd(), '../..')

function resolveContentPath(localRelative: string, dockerSubdir: string): string {
  const dockerPath = path.join(DOCKER_CONTENT, dockerSubdir)
  if (fs.existsSync(dockerPath)) return dockerPath
  return path.join(ROOT, localRelative)
}

export function loadConcepts(): LearnItem[] {
  return loadMarkdownDir(resolveContentPath('docs/src/content/docs/concepts', 'concepts'))
}

export function loadExamples(): LearnItem[] {
  return loadMarkdownDir(resolveContentPath('examples/docs', 'examples'))
}

export function getConceptBySlug(slug: string): LearnItem | undefined {
  return loadConcepts().find((c) => c.slug === slug)
}

export function getExampleBySlug(slug: string): LearnItem | undefined {
  return loadExamples().find((e) => e.slug === slug)
}
