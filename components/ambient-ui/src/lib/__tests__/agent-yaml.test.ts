import { describe, it, expect } from 'vitest'
import { agentToYaml } from '../agent-yaml'
import type { AgentYamlInput } from '../agent-yaml'

function makeAgent(overrides: Partial<AgentYamlInput> = {}): AgentYamlInput {
  return {
    name: 'test-agent',
    prompt: null,
    providers: [],
    payloads: [],
    environment: {},
    annotations: {},
    labels: {},
    ...overrides,
  }
}

describe('agentToYaml', () => {
  it('renders minimal agent in flat format', () => {
    const yaml = agentToYaml(makeAgent())
    expect(yaml).toContain('kind: Agent')
    expect(yaml).toContain('name: test-agent')
    expect(yaml).not.toContain('apiVersion:')
    expect(yaml).not.toContain('metadata:')
    expect(yaml).not.toContain('spec:')
    expect(yaml).not.toContain('providers:')
  })

  it('renders prompt as block scalar', () => {
    const yaml = agentToYaml(makeAgent({
      prompt: 'Line one\nLine two',
    }))
    expect(yaml).toContain('prompt: |')
    expect(yaml).toContain('  Line one')
    expect(yaml).toContain('  Line two')
  })

  it('renders providers list', () => {
    const yaml = agentToYaml(makeAgent({
      providers: ['github', 'jira'],
    }))
    expect(yaml).toContain('providers:')
    expect(yaml).toContain('  - github')
    expect(yaml).toContain('  - jira')
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
    expect(yaml).toContain('      key: value')
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
    expect(yaml).toContain('  LOG_LEVEL: "debug"')
    expect(yaml).toContain('  TIMEOUT: "30"')
  })

  it('renders labels and annotations', () => {
    const yaml = agentToYaml(makeAgent({
      annotations: { 'team': 'platform' },
      labels: { 'env': 'prod' },
    }))
    expect(yaml).toContain('labels:')
    expect(yaml).toContain('  env: prod')
    expect(yaml).toContain('annotations:')
    expect(yaml).toContain('  team: "platform"')
  })

  it('filters ambient.ai annotations', () => {
    const yaml = agentToYaml(makeAgent({
      annotations: {
        'ambient.ai/source-namespace': 'hidden',
        'team': 'platform',
      },
    }))
    expect(yaml).toContain('team: "platform"')
    expect(yaml).not.toContain('ambient.ai/source-namespace')
  })

  it('omits empty sections', () => {
    const yaml = agentToYaml(makeAgent())
    expect(yaml).not.toContain('annotations:')
    expect(yaml).not.toContain('labels:')
    expect(yaml).not.toContain('providers:')
    expect(yaml).not.toContain('payloads:')
    expect(yaml).not.toContain('environment:')
  })
})
