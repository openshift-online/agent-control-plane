import type { DomainSession } from './types'

const PATH_ANNOTATION = 'ambient-code.io/ui/path'

export type FolderNode = {
  name: string
  path: string
  sessionCount: number
  children: FolderNode[]
}

export function buildFolderTree(sessions: DomainSession[]): FolderNode[] {
  const pathCounts = new Map<string, number>()

  for (const session of sessions) {
    const raw = session.annotations[PATH_ANNOTATION]
    if (!raw) continue
    const path = raw.replace(/\/+$/, '')
    if (!path) continue
    pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1)
  }

  if (pathCounts.size === 0) return []

  const root: FolderNode[] = []
  const nodeMap = new Map<string, FolderNode>()

  function ensureNode(fullPath: string): FolderNode {
    const existing = nodeMap.get(fullPath)
    if (existing) return existing

    const parts = fullPath.split('/')
    const name = parts[parts.length - 1]!
    const node: FolderNode = { name, path: fullPath, sessionCount: 0, children: [] }
    nodeMap.set(fullPath, node)

    if (parts.length === 1) {
      root.push(node)
    } else {
      const parentPath = parts.slice(0, -1).join('/')
      const parent = ensureNode(parentPath)
      parent.children.push(node)
    }

    return node
  }

  for (const [path, count] of pathCounts) {
    const node = ensureNode(path)
    node.sessionCount += count
  }

  const sortNodes = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    for (const node of nodes) sortNodes(node.children)
  }
  sortNodes(root)

  return root
}

export function sessionMatchesPath(session: DomainSession, pathPrefix: string): boolean {
  const sessionPath = session.annotations[PATH_ANNOTATION]
  if (!sessionPath) return false
  const normalized = sessionPath.replace(/\/+$/, '')
  return normalized === pathPrefix || normalized.startsWith(pathPrefix + '/')
}
