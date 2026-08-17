import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { loadExamples, getExampleBySlug } from '@/lib/learn-content'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '../../_components/markdown-renderer'

type PageProps = {
  params: Promise<{ slug: string }>
}

export function generateStaticParams() {
  return loadExamples().map((e) => ({ slug: e.slug }))
}

export default async function ExampleDetailPage({ params }: PageProps) {
  const { slug } = await params
  const example = getExampleBySlug(slug)
  if (!example) notFound()

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/learn">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">{example.title}</h1>
      </div>
      <MarkdownRenderer content={example.content} />
    </div>
  )
}
