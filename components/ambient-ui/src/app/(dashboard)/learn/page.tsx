import { BookOpen, FileText } from 'lucide-react'
import { loadConcepts, loadExamples } from '@/lib/learn-content'
import { EmptyState } from '@/components/empty-state'
import { LearnCard } from './_components/learn-card'

export default function LearnPage() {
  const concepts = loadConcepts()
  const examples = loadExamples()

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Learn</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Explore platform concepts and example agents to get started.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Concepts</h2>
        {concepts.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No concepts available"
            description="Concept documentation has not been added yet."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {concepts.map((item) => (
              <LearnCard
                key={item.slug}
                title={item.title}
                description={item.description}
                section="concepts"
                slug={item.slug}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Examples</h2>
        {examples.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No examples available"
            description="Example documentation has not been added yet."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {examples.map((item) => (
              <LearnCard
                key={item.slug}
                title={item.title}
                description={item.description}
                section="examples"
                slug={item.slug}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
