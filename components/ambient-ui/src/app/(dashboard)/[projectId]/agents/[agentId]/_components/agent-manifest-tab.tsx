"use client";

import { useState, useCallback, useMemo } from "react";
import {
  Copy,
  Download,
  Check,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DomainAgent } from "@/domain/types";
import { agentToYaml } from "@/lib/agent-yaml";

type ConfigRow = { label: string; value: React.ReactNode; mono?: boolean };

export function AgentManifestTab({
  agent,
}: {
  agent: DomainAgent;
}) {
  const [copied, setCopied] = useState(false);

  const yaml = useMemo(() => agentToYaml(agent), [agent]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(yaml);
    setCopied(true);
    globalThis.setTimeout(() => setCopied(false), 2000);
  }, [yaml]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([yaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `agent-${agent.name}.yaml`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [yaml, agent.name]);

  const envEntries = Object.entries(agent.environment);

  const configRows: ConfigRow[] = [];
  configRows.push({ label: "Name", value: agent.name, mono: true });
  if (agent.displayName) configRows.push({ label: "Display Name", value: agent.displayName });
  if (agent.description) configRows.push({ label: "Description", value: agent.description });
  if (agent.model) configRows.push({ label: "Model", value: agent.model, mono: true });
  if (agent.entrypoint) configRows.push({ label: "Entrypoint", value: agent.entrypoint, mono: true });
  if (agent.repoUrl) configRows.push({
    label: "Repository",
    value: (
      <a href={agent.repoUrl} target="_blank" rel="noopener noreferrer" className="text-link underline hover:text-link-hover">
        {agent.repoUrl}
      </a>
    ),
  });
  if (agent.sandboxPolicy) configRows.push({ label: "Sandbox Policy", value: agent.sandboxPolicy });
  if (agent.providers.length > 0) configRows.push({
    label: "Providers",
    value: (
      <div className="flex flex-wrap gap-1.5">
        {agent.providers.map((p) => (
          <Badge key={p} variant="secondary">{p}</Badge>
        ))}
      </div>
    ),
  });
  if (agent.sandboxTemplate?.image) configRows.push({ label: "Image", value: agent.sandboxTemplate.image, mono: true });
  if (agent.sandboxTemplate?.resources?.cpu) configRows.push({ label: "CPU", value: agent.sandboxTemplate.resources.cpu });
  if (agent.sandboxTemplate?.resources?.memory) configRows.push({ label: "Memory", value: agent.sandboxTemplate.resources.memory });
  if (agent.sandboxTemplate?.gpu?.count != null) configRows.push({ label: "GPU Count", value: String(agent.sandboxTemplate.gpu.count) });
  if (agent.sandboxTemplate?.runtime_class_name) configRows.push({ label: "Runtime Class", value: agent.sandboxTemplate.runtime_class_name });

  return (
    <div className="space-y-6 pt-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {configRows.map((row) => (
                <TableRow key={row.label}>
                  <TableCell className="font-medium text-sm w-40">{row.label}</TableCell>
                  <TableCell className={row.mono ? "font-mono text-sm" : "text-sm"}>{row.value}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {agent.prompt && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Prompt</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap rounded-md bg-muted p-4 text-sm font-mono overflow-x-auto">
              {agent.prompt}
            </pre>
          </CardContent>
        </Card>
      )}

      {agent.payloads.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payloads ({agent.payloads.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sandbox Path</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Ref</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agent.payloads.map((payload) => (
                  <TableRow key={payload.sandbox_path}>
                    <TableCell className="font-mono text-xs">{payload.sandbox_path}</TableCell>
                    <TableCell className="text-sm">
                      {payload.repo_url ? (
                        <a href={payload.repo_url} target="_blank" rel="noopener noreferrer" className="text-link underline hover:text-link-hover">
                          {payload.repo_url}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">inline content</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{payload.ref ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {envEntries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Environment ({envEntries.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variable</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {envEntries.map(([key, value]) => (
                  <TableRow key={key}>
                    <TableCell className="font-mono text-xs">{key}</TableCell>
                    <TableCell className="font-mono text-xs">{value}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Manifest</CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleCopy}>
                {copied ? (
                  <>
                    <Check className="size-4 mr-1.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-4 mr-1.5" />
                    Copy
                  </>
                )}
              </Button>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="size-4 mr-1.5" />
                Download
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap rounded-md bg-muted p-4 text-sm font-mono overflow-x-auto">
            {yaml}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
