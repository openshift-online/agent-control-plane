import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeMermaid from 'rehype-mermaid';

const getBasePath = () => {
  if (process.env.PR_PREVIEW_PATH) {
    return process.env.PR_PREVIEW_PATH;
  }
  if (process.env.NETLIFY) {
    return '/';
  }
  return process.env.CI ? '/agent-control-plane/' : '/';
};

export default defineConfig({
  site: process.env.NETLIFY
    ? process.env.URL
    : 'https://openshift-online.github.io',
  base: getBasePath(),
  integrations: [
    starlight({
      title: 'Agent Control Plane',
      favicon: '/favicon.ico',
      description:
        'AI-powered automation platform for intelligent agentic workflows',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/openshift-online/agent-control-plane',
        },
      ],
      editLink: {
        baseUrl:
          'https://github.com/openshift-online/agent-control-plane/edit/main/docs/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { slug: 'getting-started' },
            { slug: 'getting-started/quickstart-ui' },
            { slug: 'getting-started/concepts' },
            { slug: 'getting-started/cli' },
          ],
        },
        {
          label: 'Core Concepts',
          items: [
            { slug: 'concepts/credentials' },
            { slug: 'concepts/projects' },
            { slug: 'concepts/agents' },
            { slug: 'concepts/sessions' },
            { slug: 'concepts/scheduled-sessions' },
            { slug: 'concepts/context-and-artifacts' },
            { slug: 'concepts/workflows' },
          ],
        },
        {
          label: 'Workflows',
          items: [
            { slug: 'workflows' },
            { slug: 'workflows/bugfix' },
            { slug: 'workflows/triage' },
            { slug: 'workflows/prd-rfe' },
            { slug: 'workflows/custom' },
          ],
        },
        {
          label: 'Features',
          items: [
            { slug: 'features/session-sharing' },
            { slug: 'features/coderabbit' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'guides/custom-ca-bundle' },
            { slug: 'guides/work-tracking-annotations' },
          ],
        },
        {
          label: 'Extensions',
          items: [
            { slug: 'extensions/github-action' },
            { slug: 'extensions/mcp-server' },
          ],
        },
        {
          label: 'Toolbox',
          items: [
            { slug: 'ecosystem/amber' },
            { slug: 'ecosystem/agentready' },
          ],
        },
        {
          label: 'Development',
          items: [
            { slug: 'development' },
            { slug: 'development/architecture' },
          ],
        },
      ],
      customCss: ['./src/styles/custom.css'],
    }),
  ],
  markdown: {
    rehypePlugins: [[rehypeMermaid, { strategy: 'inline-svg' }]],
  },
});
