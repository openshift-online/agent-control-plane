'use client'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { DomainPolicy } from '@/domain/types'

export function PoliciesTable({ policies }: { policies: DomainPolicy[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Namespace</TableHead>
          <TableHead>Sections</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {policies.map((policy) => (
          <TableRow key={policy.id}>
            <TableCell className="font-medium">{policy.name}</TableCell>
            <TableCell className="text-muted-foreground">{policy.namespace}</TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {Object.keys(policy.spec).join(', ') || '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
