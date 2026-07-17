# Learn Specification

## Purpose

The Learn view provides an in-app learning hub with two sections: **Concepts** (platform fundamentals) and **Examples** (runnable demos). Users can browse and read all learning content without leaving the UI or navigating to the source repository. The content is static — compiled at build time from markdown files already present in the repository. Inspired by OpenShift AI's "Resources" page and Developer Hub's "Learning Paths".

## Content Sources

| Section | Source directory | Scope |
|---------|-----------------|-------|
| Concepts | `docs/src/content/docs/concepts/*.md` | Platform fundamentals (agents, sessions, projects, credentials, workflows, scheduled sessions, context & artifacts) |
| Examples | `examples/docs/*.md` | Runnable demos and use-case walkthroughs |

> **Note:** The `examples/docs/` directory is located at the repository root (`<repo>/examples/docs/`). It does not currently exist and is created as part of this feature with at least one initial example file to validate the build pipeline. The `docs/src/content/docs/concepts/` directory already exists with 7 concept files.

## Requirements

### Requirement: Learn Landing Page

The Ambient UI SHALL include a "Learn" view accessible from the main sidebar navigation. The landing page SHALL display two sections: **Concepts** and **Examples**. Each section SHALL render a card grid of its learning resources.

Each card SHALL display:

- **Title** — extracted from the `title` frontmatter field if present, otherwise from the first `# heading`, otherwise the filename (without extension).
- **Description** — extracted from the first paragraph after the heading (truncated to 200 characters).

#### Scenario: Landing page renders both sections

- GIVEN `docs/src/content/docs/concepts/` contains `agents.md`, `sessions.md`, and `projects.md`
- AND `examples/docs/` contains `hello-world.md` and `pr-review.md`
- WHEN the Learn view renders
- THEN a "Concepts" section appears with 3 cards
- AND an "Examples" section appears with 2 cards

#### Scenario: Section with no content shows empty state

- GIVEN `examples/docs/` contains no markdown files
- AND `docs/src/content/docs/concepts/` contains 7 files
- WHEN the Learn view renders
- THEN the "Concepts" section renders 7 cards
- AND the "Examples" section displays "No examples available"

### Requirement: Concept Detail Rendering

Clicking a Concepts card SHALL navigate to a detail page that renders the full markdown content of the concept file. The rendered content SHALL support standard GitHub-flavored Markdown: headings, lists, code blocks with syntax highlighting, tables, links, and inline images.

Concept files use Starlight frontmatter (`title`, etc.). The renderer SHALL extract the `title` field for the page heading and strip the frontmatter before rendering the body.

#### Scenario: User reads a concept

- GIVEN the Concepts section displays "Agents", "Sessions", and "Projects"
- WHEN the user clicks "Agents"
- THEN the view navigates to `/learn/concepts/agents`
- AND the page heading displays "Agents" (from frontmatter `title`)
- AND the full body of `agents.md` is rendered as formatted HTML
- AND code blocks display syntax highlighting

#### Scenario: Back navigation

- GIVEN the user is viewing a concept detail page
- WHEN the user clicks the back button or breadcrumb
- THEN the view returns to the Learn landing page

#### Scenario: Malformed markdown graceful degradation

- GIVEN a concept file contains malformed markdown
- WHEN the user navigates to its detail page
- THEN the page heading displays the filename as title
- AND the detail page renders the raw text as fallback

### Requirement: Example Detail Rendering

Clicking an Examples card SHALL navigate to a detail page that renders the full markdown content of the example file. Behavior is identical to concept detail rendering.

#### Scenario: User reads an example

- GIVEN the Examples section displays "Hello World" and "PR Review"
- WHEN the user clicks "Hello World"
- THEN the view navigates to `/learn/examples/hello-world`
- AND the full content of `hello-world.md` is rendered as formatted HTML

### Requirement: Static Build-Time Discovery

All learning content SHALL be statically imported at build time. Adding a new concept or example SHALL require only adding a new `.md` file to the corresponding source directory — no code changes, no configuration updates, no database entries.

The build process SHALL discover all `.md` files in each source directory (non-recursive — subdirectories are ignored) and include their content in the UI bundle.

> **Build pipeline dependency:** Both source directories live outside the UI component tree (`components/ambient-ui/`). The build pipeline MUST make this content available to the Next.js build process. The preferred mechanism is a **Makefile pre-build copy step** that copies markdown files into a temporary directory inside the build context (`components/ambient-ui/.learn-content/`) before the Docker build, then cleans up after. This approach keeps source files in their canonical locations, works within Docker's single build-context constraint, and requires no changes to the Astro docs site. The content loader resolves paths at runtime: Docker path (`/learn-content/`) first, local development fallback (`../../`) second.

#### Scenario: Adding a new concept

- GIVEN `docs/src/content/docs/concepts/` contains 7 files
- WHEN a developer adds `gateways.md` with frontmatter `title: "Gateways"`
- AND the UI is rebuilt
- THEN the Concepts section displays 8 cards including "Gateways"
- AND no other file was modified

#### Scenario: Adding a new example

- GIVEN `examples/docs/` contains `hello-world.md`
- WHEN a developer adds `jira-categorizer.md` to `examples/docs/`
- AND the UI is rebuilt
- THEN the Examples section displays both "Hello World" and "Jira Categorizer"

#### Scenario: Subdirectories are ignored

- GIVEN `docs/src/content/docs/concepts/drafts/wip.md` exists
- WHEN the UI is built
- THEN "wip" does NOT appear in the Concepts section

### Requirement: Sidebar Navigation Entry

The Learn view SHALL appear as an ungrouped entry in the main sidebar navigation, below the existing "Configure" group. The entry SHALL be visible to all authenticated users regardless of role or project context. The Learn view is global — it is NOT scoped to a project.

#### Scenario: Navigation entry visible

- GIVEN an authenticated user with any role
- WHEN the sidebar renders
- THEN a "Learn" entry is visible at the bottom of the sidebar, below Configure
- AND clicking it navigates to `/learn`

## URL Routes

| Route | View | Scope |
|-------|------|-------|
| `/learn` | Learn landing page (Concepts + Examples card grids) | Global |
| `/learn/concepts/{slug}` | Concept detail (rendered markdown) | Global |
| `/learn/examples/{slug}` | Example detail (rendered markdown) | Global |

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Reuse existing concept docs | `docs/src/content/docs/concepts/` already contains well-structured concept files. Single source of truth avoids duplication and maintenance drift. |
| Static build-time content, no API | Learning content changes infrequently and lives in the repository. No backend, no database, no runtime fetch. |
| Global (not project-scoped) | Learning resources describe platform capabilities, not project-specific resources. |
| Port/adapter exemption | Static build-time content does not flow through the API server. The port/adapter pattern defined in the architecture spec applies to API-backed data sources. Build-time content is exempt. |
| No search/filter initially | The catalog is expected to remain small (<20 entries across both sections). Search is deferred until the catalog grows. |
| Card grid layout | Consistent with OpenShift AI Resources and Developer Hub Learning Paths patterns. |
| Frontmatter title extraction | Concept files use Starlight frontmatter with `title` field. Reusing this avoids parsing inconsistencies and matches the existing authoring convention. |
