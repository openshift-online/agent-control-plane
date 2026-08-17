import Link from 'next/link'
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

type LearnCardProps = {
  title: string
  description: string
  section: 'concepts' | 'examples'
  slug: string
}

export function LearnCard({ title, description, section, slug }: LearnCardProps) {
  const safePath = `/learn/${encodeURIComponent(section)}/${encodeURIComponent(slug)}`
  return (
    <Link href={safePath} className="group">
      <Card className="h-full transition-colors group-hover:border-primary/50">
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
          {description && (
            <CardDescription className="line-clamp-3">{description}</CardDescription>
          )}
        </CardHeader>
      </Card>
    </Link>
  )
}
