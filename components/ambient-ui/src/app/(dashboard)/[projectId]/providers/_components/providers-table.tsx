'use client'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import type { DomainProvider } from '@/domain/types'

export function ProvidersTable({ providers }: { providers: DomainProvider[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Secret</TableHead>
          <TableHead>Namespace</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {providers.map((provider) => (
          <TableRow key={provider.id}>
            <TableCell className="font-medium">{provider.name}</TableCell>
            <TableCell>
              <Badge variant="secondary">{provider.type}</Badge>
            </TableCell>
            <TableCell className="font-mono text-xs">{provider.secret}</TableCell>
            <TableCell className="text-muted-foreground">{provider.namespace}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
