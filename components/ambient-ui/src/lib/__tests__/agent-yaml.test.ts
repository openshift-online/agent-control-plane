import { describe, it, expect } from 'vitest'
import { agentToYaml, agentToConfigMapYaml } from '../agent-yaml'
import type { ConfigMapAgentInput } from '../agent-yaml'
import type { DomainAgent } from '@/domain/types'

function makeAgent(overrides: Partial<DomainAgent> = {}): DomainAgent {
  return {
    id: 'agent-1',
    name: 'test-agent',
    displayName: null,
    description: null,
    model: null,
    ownerUserId: null,
    currentSessionId: null,
    projectId: 'proj-1',
    prompt: null,
    repoUrl: null,
    workflowId: null,
    entrypoint: null,
    providers: [],
    payloads: [],
    environment: {},
    sandboxTemplate: null,
    sandboxPolicy: null,
    annotations: {},
    labels: {},
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('agentToYaml', () => {
  it('renders minimal agent', () => {
    const yaml = agentToYaml(makeAgent())
    expect(yaml).toContain('kind: Agent')
    expect(yaml).toContain('name: test-agent')
    expect(yaml).toContain('spec:')
    expect(yaml).not.toContain('providers:')
    expect(yaml).not.toContain('sandboxTemplate:')
  })

  it('renders display name and description', () => {
    const yaml = agentToYaml(makeAgent({
      displayName: 'Test Agent',
      description: 'Does things',
    }))
    expect(yaml).toContain('displayName: "Test Agent"')
    expect(yaml).toContain('description: "Does things"')
  })

  it('renders prompt as block scalar', () => {
    const yaml = agentToYaml(makeAgent({
      prompt: 'Line one\nLine two',
    }))
    expect(yaml).toContain('prompt: |')
    expect(yaml).toContain('    Line one')
    expect(yaml).toContain('    Line two')
  })

  it('renders providers list', () => {
    const yaml = agentToYaml(makeAgent({
      providers: ['github', 'jira'],
    }))
    expect(yaml).toContain('providers:')
    expect(yaml).toContain('    - github')
    expect(yaml).toContain('    - jira')
  })

  it('renders payloads with content', () => {
    const yaml = agentToYaml(makeAgent({
      payloads: [{
        sandbox_path: '/workspace/config',
        content: 'key: value',
      }],
    }))
    expect(yaml).toContain('sandbox_path: /workspace/config')
    expect(yaml).toContain('content: |')
    expect(yaml).toContain('        key: value')
  })

  it('renders payloads with repo_url', () => {
    const yaml = agentToYaml(makeAgent({
      payloads: [{
        sandbox_path: '/workspace/repo',
        repo_url: 'https://github.com/example/repo',
        ref: 'main',
      }],
    }))
    expect(yaml).toContain('repo_url: https://github.com/example/repo')
    expect(yaml).toContain('ref: main')
  })

  it('renders environment variables', () => {
    const yaml = agentToYaml(makeAgent({
      environment: { LOG_LEVEL: 'debug', TIMEOUT: '30' },
    }))
    expect(yaml).toContain('environment:')
    expect(yaml).toContain('LOG_LEVEL: "debug"')
    expect(yaml).toContain('TIMEOUT: "30"')
  })

  it('renders sandbox template', () => {
    const yaml = agentToYaml(makeAgent({
      sandboxTemplate: {
        image: 'quay.io/custom:v1',
        resources: { cpu: '2', memory: '4Gi' },
        gpu: { count: 1 },
      },
    }))
    expect(yaml).toContain('sandboxTemplate:')
    expect(yaml).toContain('image: quay.io/custom:v1')
    expect(yaml).toContain('cpu: "2"')
    expect(yaml).toContain('memory: 4Gi')
    expect(yaml).toContain('count: 1')
  })

  it('renders entrypoint and sandbox policy', () => {
    const yaml = agentToYaml(makeAgent({
      entrypoint: '/usr/bin/review',
      sandboxPolicy: 'restricted',
    }))
    expect(yaml).toContain('entrypoint: /usr/bin/review')
    expect(yaml).toContain('sandboxPolicy: restricted')
  })

  it('renders annotations and labels', () => {
    const yaml = agentToYaml(makeAgent({
      annotations: { 'team': 'platform' },
      labels: { 'env': 'prod' },
    }))
    expect(yaml).toContain('annotations:')
    expect(yaml).toContain('team: "platform"')
    expect(yaml).toContain('labels:')
    expect(yaml).toContain('env: "prod"')
  })

  it('omits empty sections', () => {
    const yaml = agentToYaml(makeAgent())
    expect(yaml).not.toContain('annotations:')
    expect(yaml).not.toContain('labels:')
    expect(yaml).not.toContain('providers:')
    expect(yaml).not.toContain('payloads:')
    expect(yaml).not.toContain('environment:')
    expect(yaml).not.toContain('sandboxTemplate:')
  })
})

describe('agentToConfigMapYaml', () => {
  function makeInput(overrides: Partial<ConfigMapAgentInput> = {}): ConfigMapAgentInput {
    return {
      name: 'test-agent',
      namespace: 'tenant-a',
      ...overrides,
    }
  }

  it('renders minimal ConfigMap', () => {
    const yaml = agentToConfigMapYaml(makeInput())
    expect(yaml).toContain('kind: ConfigMap')
    expect(yaml).toContain('name: agent-test-agent')
    expect(yaml).toContain('namespace: tenant-a')
    expect(yaml).toContain('ambient.ai/kind: agent')
    expect(yaml).toContain('test-agent: |')
    expect(yaml).toContain('    name: test-agent')
  })

  it('renders full agent declaration', () => {
    const yaml = agentToConfigMapYaml(makeInput({
      displayName: 'Test Agent',
      description: 'Does things',
      model: 'claude-sonnet-4-5',
      entrypoint: 'claude',
      prompt: 'You are a helper.',
      providers: ['github', 'anthropic'],
      sandboxPolicy: 'restricted',
      environment: { LOG_LEVEL: 'debug' },
      sandboxTemplate: {
        image: 'quay.io/custom:v1',
        resources: { cpu: '2', memory: '4Gi' },
      },
    }))
    expect(yaml).toContain('display_name: Test Agent')
    expect(yaml).toContain('entrypoint: claude')
    expect(yaml).toContain('model: claude-sonnet-4-5')
    expect(yaml).toContain('prompt: |')
    expect(yaml).toContain('      You are a helper.')
    expect(yaml).toContain('      - github')
    expect(yaml).toContain('      - anthropic')
    expect(yaml).toContain('sandbox_policy: restricted')
    expect(yaml).toContain('LOG_LEVEL: "debug"')
    expect(yaml).toContain('image: quay.io/custom:v1')
    expect(yaml).toContain('cpu: "2"')
    expect(yaml).toContain('memory: 4Gi')
  })

  it('omits empty optional fields', () => {
    const yaml = agentToConfigMapYaml(makeInput())
    expect(yaml).not.toContain('display_name:')
    expect(yaml).not.toContain('providers:')
    expect(yaml).not.toContain('environment:')
    expect(yaml).not.toContain('sandbox_template:')
    expect(yaml).not.toContain('sandbox_policy:')
  })

  it('renders payloads with repo_url', () => {
    const yaml = agentToConfigMapYaml(makeInput({
      payloads: [{
        sandbox_path: '/workspace/repo',
        repo_url: 'https://github.com/org/repo',
        ref: 'main',
      }],
    }))
    expect(yaml).toContain('sandbox_path: /workspace/repo')
    expect(yaml).toContain('repo_url: https://github.com/org/repo')
    expect(yaml).toContain('ref: main')
  })
})
