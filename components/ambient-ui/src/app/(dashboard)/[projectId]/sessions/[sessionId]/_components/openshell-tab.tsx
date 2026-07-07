'use client'

import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollText, FileKey } from 'lucide-react'
import type { DomainSession } from '@/domain/types'
import { SandboxLogsTab } from './sandbox-logs-tab'
import { SandboxPolicyTab } from './sandbox-policy-tab'

export function OpenShellTab({ session }: { session: DomainSession }) {
  const [subTab, setSubTab] = useState('sandbox-logs')

  return (
    <div className="pt-4">
      <Tabs value={subTab} onValueChange={setSubTab}>
        <TabsList>
          <TabsTrigger value="sandbox-logs">
            <ScrollText className="size-3.5 mr-1.5" /> Sandbox Logs
          </TabsTrigger>
          <TabsTrigger value="sandbox-policy">
            <FileKey className="size-3.5 mr-1.5" /> Sandbox Policy
          </TabsTrigger>
        </TabsList>
        <TabsContent value="sandbox-logs">
          <SandboxLogsTab session={session} />
        </TabsContent>
        <TabsContent value="sandbox-policy">
          <SandboxPolicyTab session={session} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
