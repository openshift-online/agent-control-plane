"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  Pin,
  Tag,
  Ticket,
  GitPullRequest,
  GitBranch,
  FolderGit2,
  Layers,
  ExternalLink,
  MessageCircle,
  User,
  Play,
  DollarSign,
  Siren,
  Bot,
  AlertTriangle,
  Info,
  Copy,
  Download,
  Check,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getRegisteredAnnotation } from "@/domain/annotations";
import type { DomainAgent } from "@/domain/types";
import type { AgentLifecycle } from "../../_components/lifecycle-badge";
import { useUpdateAgent } from "@/queries/use-agents";
import { MODEL_OPTIONS } from "@/domain/models";
import { agentToYaml, agentToConfigMapYaml } from "@/lib/agent-yaml";
import { useGatewayMode } from "@/lib/use-gateway-mode";

const ICON_MAP: Record<string, LucideIcon> = {
  pin: Pin,
  tag: Tag,
  ticket: Ticket,
  layers: Layers,
  play: Play,
  bot: Bot,
  siren: Siren,
  user: User,
  "dollar-sign": DollarSign,
  "git-pull-request": GitPullRequest,
  "git-branch": GitBranch,
  "folder-git-2": FolderGit2,
  "external-link": ExternalLink,
  "message-circle": MessageCircle,
  "alert-triangle": AlertTriangle,
};

function isClickableValue(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function GatewayManifestTab({ agent }: { agent: DomainAgent }) {
  const [copied, setCopied] = useState(false);

  const sourceNamespace =
    agent.annotations["ambient.ai/source-namespace"] ?? agent.projectId;

  const yaml = useMemo(
    () =>
      agentToConfigMapYaml({
        name: agent.name,
        namespace: sourceNamespace,
        displayName: agent.displayName ?? undefined,
        description: agent.description ?? undefined,
        model: agent.model ?? undefined,
        prompt: agent.prompt ?? undefined,
        repoUrl: agent.repoUrl ?? undefined,
        entrypoint: agent.entrypoint ?? undefined,
        providers: agent.providers.length > 0 ? agent.providers : undefined,
        payloads: agent.payloads.length > 0 ? agent.payloads : undefined,
        environment:
          Object.keys(agent.environment).length > 0
            ? agent.environment
            : undefined,
        sandboxTemplate: agent.sandboxTemplate ?? undefined,
        sandboxPolicy: agent.sandboxPolicy ?? undefined,
      }),
    [agent, sourceNamespace],
  );

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

  type ConfigRow = { label: string; value: React.ReactNode; mono?: boolean };
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
  configRows.push({ label: "Namespace", value: sourceNamespace, mono: true });
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
      <div className="flex items-start gap-3 rounded-md border border-muted bg-muted/50 p-4">
        <Info className="size-5 shrink-0 text-muted-foreground mt-0.5" />
        <div>
          <p className="text-sm font-medium">GitOps-managed agent</p>
          <p className="text-sm text-muted-foreground">
            This agent is managed via GitOps in namespace{" "}
            <span className="font-mono">{sourceNamespace}</span>. To modify it,
            update the ConfigMap and re-apply with{" "}
            <span className="font-mono">kubectl apply</span>.
          </p>
        </div>
      </div>

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
            <CardTitle className="text-base">ConfigMap YAML</CardTitle>
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

export function AgentManifestTab({
  agent,
  lifecycle,
}: {
  agent: DomainAgent;
  lifecycle: AgentLifecycle;
}) {
  const gatewayMode = useGatewayMode();

  if (gatewayMode) {
    return <GatewayManifestTab agent={agent} />;
  }

  return <StandardManifestTab agent={agent} lifecycle={lifecycle} />;
}

function StandardManifestTab({
  agent,
  lifecycle,
}: {
  agent: DomainAgent;
  lifecycle: AgentLifecycle;
}) {
  const { projectId } = useParams<{ projectId: string }>();
  const isManaged = lifecycle === "gitops";
  const updateAgent = useUpdateAgent();

  const [displayName, setDisplayName] = useState(agent.displayName ?? "");
  const [model, setModel] = useState(agent.model ?? "");
  const [prompt, setPrompt] = useState(agent.prompt ?? "");
  const [repoUrl, setRepoUrl] = useState(agent.repoUrl ?? "");
  const [description, setDescription] = useState(agent.description ?? "");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDisplayName(agent.displayName ?? "");
    setModel(agent.model ?? "");
    setPrompt(agent.prompt ?? "");
    setRepoUrl(agent.repoUrl ?? "");
    setDescription(agent.description ?? "");
  }, [agent]);

  const handleSave = useCallback(async () => {
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const updated = await updateAgent.mutateAsync({
        projectId,
        agentId: agent.id,
        request: {
          displayName: displayName || undefined,
          model: model || undefined,
          prompt: prompt || undefined,
          repoUrl: repoUrl || undefined,
          description: description || undefined,
        },
      });
      setDisplayName(updated.displayName ?? "");
      setModel(updated.model ?? "");
      setPrompt(updated.prompt ?? "");
      setRepoUrl(updated.repoUrl ?? "");
      setDescription(updated.description ?? "");
      setSaveSuccess(true);
      globalThis.setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to save changes.",
      );
    }
  }, [
    updateAgent,
    projectId,
    agent.id,
    displayName,
    model,
    prompt,
    repoUrl,
    description,
  ]);

  const liveAgent = useMemo(
    (): DomainAgent => ({
      ...agent,
      displayName: displayName || null,
      model: model || null,
      prompt: prompt || null,
      repoUrl: repoUrl || null,
      description: description || null,
    }),
    [agent, displayName, model, prompt, repoUrl, description],
  );

  const yaml = useMemo(() => agentToYaml(liveAgent), [liveAgent]);

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

  const annotationEntries = Object.entries(agent.annotations);

  return (
    <div className="space-y-6 pt-4">
      {isManaged && (
        <div className="flex items-start gap-3 rounded-md border border-muted bg-muted/50 p-4">
          <Info className="size-5 shrink-0 text-muted-foreground mt-0.5" />
          <div>
            <p className="text-sm font-medium">GitOps-managed agent</p>
            <p className="text-sm text-muted-foreground">
              This agent is managed via GitOps
              {agent.annotations["ambient.ai/source-namespace"]
                ? ` in namespace ${agent.annotations["ambient.ai/source-namespace"]}`
                : ""}
              . This is viewable only. Edits to this resource should occur via
              the ConfigMap declaration.
            </p>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="agent-display-name" className="text-sm font-medium">
              Display Name
            </label>
            <Input
              id="agent-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Human-readable name"
              disabled={isManaged}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="agent-model" className="text-sm font-medium">
              Model
            </label>
            <Select value={model} onValueChange={setModel} disabled={isManaged}>
              <SelectTrigger id="agent-model" className="w-full">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="agent-repo-url" className="text-sm font-medium">
              Repository URL
            </label>
            <Input
              id="agent-repo-url"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
              disabled={isManaged}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="agent-description" className="text-sm font-medium">
              Description
            </label>
            <Textarea
              id="agent-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this agent do?"
              className="min-h-20"
              disabled={isManaged}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="agent-prompt" className="text-sm font-medium">
              Prompt
            </label>
            <Textarea
              id="agent-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="System prompt for the agent..."
              className="min-h-40 font-mono text-sm"
              disabled={isManaged}
            />
          </div>

          {!isManaged && (
            <div className="flex items-center gap-3 pt-2">
              <Button onClick={handleSave} disabled={updateAgent.isPending}>
                {updateAgent.isPending ? "Saving..." : "Save Changes"}
              </Button>
              {saveSuccess && (
                <span className="text-sm text-success-foreground">
                  Changes saved.
                </span>
              )}
              {saveError && (
                <span className="text-sm text-destructive">{saveError}</span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">YAML Definition</CardTitle>
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

      {annotationEntries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Annotations ({annotationEntries.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {annotationEntries.map(([key, value]) => {
                  const registered = getRegisteredAnnotation(key);
                  const Icon = registered?.icon
                    ? ICON_MAP[registered.icon]
                    : null;
                  const clickable = isClickableValue(value);
                  return (
                    <TableRow key={key}>
                      <TableCell className="font-mono text-xs">
                        <span className="inline-flex items-center gap-1.5">
                          {Icon && (
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          {registered ? registered.label : key}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm">
                        {clickable ? (
                          <a
                            href={value}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate text-link underline hover:text-link-hover"
                          >
                            {value}
                          </a>
                        ) : (
                          value
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {Object.keys(agent.labels).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Labels ({Object.keys(agent.labels).length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(agent.labels).map(([key, value]) => (
                <Badge key={key} variant="secondary" className="text-xs">
                  {key}: {value}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
