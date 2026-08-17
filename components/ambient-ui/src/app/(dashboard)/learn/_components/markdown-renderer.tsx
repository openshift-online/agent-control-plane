'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type MarkdownRendererProps = {
  content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <article className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content}
      </ReactMarkdown>
    </article>
  )
}
