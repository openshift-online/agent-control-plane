# Synthetic vTeam Work Packet: Team Creation Onboarding Wizard

## Target

ACP tenant onboarding experience in `components/ambient-ui`, focused on a new
Team Creation wizard that prepares a workspace/project for session-config-driven
agent runs.

## Objective

Design a small onboarding flow that helps a tenant admin create a team
workspace. The flow connects corporate SSO identity, maps people into ACP
roles, and applies session defaults based on team membership.

The goal is not to build a full identity-management product. Keep the first
pass to a wizard.

Keep the supporting product contract around existing ACP primitives:
projects/workspaces, role bindings, project settings, project prompt context,
credentials, agents, and workflow/session-config payloads.

## Wizard Shape

1. **Team basics**: team name, workspace/project slug, owner, purpose, and
   default project prompt context.
2. **Corporate SSO**: show the connected OIDC issuer, accepted claims, and
   detected group claim shape.
3. **People mapping**: map SSO groups or selected users to ACP roles such as
   `project:owner`, `project:editor`, and `project:viewer`.
4. **Session defaults**: choose the default session-config repository, payload
   path, agent roster, model defaults, and team-specific prompt additions.
5. **Review and create**: preview the project, role bindings, providers,
   agents, payloads, and unresolved gaps before applying.

## Scope

- Add a wizard surface or mockable implementation plan for team creation.
- Use existing authenticated user and OIDC claim information where available.
- Create or preview the ACP project/workspace and role bindings implied by the
  selected people mappings.
- Store non-secret team defaults in project settings or project prompt context.
- Keep secrets in credentials and provider bindings, not project settings.
- Use workflow/session-config payloads for portable team-specific instructions.
- Show a clear preview of what will be created before the user confirms.
- Include empty, partial, and unsupported-claim states.

## Out Of Scope

- Building a new identity provider.
- Writing a corporate directory synchronizer.
- Automatically granting access from every SSO group without admin review.
- Storing secrets in session-config repositories.
- Creating a first-class `Team` API object unless a gap analysis proves ACP
  primitives are insufficient.
- Full scheduled synchronization or drift repair.

## Known ACP Gaps To Flag

- No first-class Team object distinct from Project/Workspace.
- No confirmed SSO group-to-role-binding automation contract.
- No built-in corporate directory people browser beyond authenticated user data.
- No native session-config recommendation engine based on team membership.
- No versioned install state for a team's wizard output.

If any of these become necessary to meet the acceptance criteria, flag the gap
before implementing a workaround.

## Agent Plan

### Stella

Owns technical direction. Stella should map each wizard output to ACP primitives,
identify hard platform gaps, and keep the first pass limited to preview plus
create/update flows that fit the current API.

### Parker

Owns product framing. Parker should define the tenant-admin job, the minimum
useful wizard, the role-mapping acceptance criteria, and what must be deferred.

### Ryan

Owns research sanity. Ryan should list the people/admin questions the wizard
must answer and separate likely enterprise onboarding assumptions from evidence.

### Steve

Owns interaction design. Steve should sketch the stepper, review preview,
unsupported-claim states, people mapping table, and mobile/tablet fallback.

### Amber

Owns implementation and code review. Amber should inspect auth, projects, role
bindings, project settings, agents, providers, and workflow/session-config
surfaces before proposing the smallest implementation slice.

### Terry

Owns documentation. Terry should write the admin-facing setup notes, document
which SSO claims are used, and make the generated session-config behavior clear.

## Acceptance Criteria

- The wizard can express a team name, owner, workspace/project, SSO group/user
  mappings, and default session-config payload.
- The review step previews every ACP resource or setting that will be created or
  updated.
- The flow never stores secrets in project settings or session-config repos.
- Unsupported or missing SSO group claims are visible and actionable.
- Session customization is traceable to project prompt, agent prompt, project
  settings, credential bindings, or workflow/session-config payloads.
- Any need for a new Team API, directory sync, or membership engine is listed as
  a product/platform gap instead of being silently approximated.

## Suggested First Prompt

Stella, coordinate the vTeam on a Team Creation onboarding wizard for ACP. Keep
it focused on tenant admins connecting corporate SSO people/groups to ACP
projects, role bindings, and session-config defaults. Use existing primitives
where they fit and flag any platform gaps before proposing workarounds.
