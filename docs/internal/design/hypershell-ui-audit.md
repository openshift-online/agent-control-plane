# Hypershell UI Audit

The UI audit skill requires 15 independent reviews per pass, for three passes.
Each reviewer applies the named expert's design principles. The reviews do not
claim to represent that person.

Pass 1 used source review because the test UI was not yet deployed. All 15
reviews are complete: Don Norman, Edward Tufte, Jakob Nielsen, Steve Krug,
Alan Cooper, Jared Spool, Jesse James Garrett, Indi Young, Erika Hall,
Julie Zhuo, Luke Wroblewski, Katie Dill, Golden Krishna, Bret Victor, and Irene Au.

The accepted findings were fixed in commit `86d13cf5`:

- Keep polling while runtime cleanup continues after a terminal session phase.
- Show workspace preparation until the gateway is ready.
- Give a clear failure message and a next step when error detail is absent.
- Distinguish unavailable status from active preparation.
- Use text that fits the repository empty state.
- Wrap long errors and use text with sufficient contrast.
- Let users scroll the session tabs on narrow screens.
- Stop failed log retries, report the failure, and provide a Retry button.
- Keep the backend name in resource details.

The UI spec was updated. TypeScript checks, 86 focused tests, and focused lint
passed.

All 15 reviewers completed pass 2. Commit `72c728da` clears the log error when
streaming stops and hides Retry while streaming is inactive. Five focused tests
passed.

All 15 reviewers completed pass 3. Commit `58d852cb` keeps status polling active
while a terminal session still has a running sandbox. It also lets users scroll
the OpenShell tabs, limits failed log retries, reports connection state, and
shows the next action for a degraded gateway. TypeScript, focused lint, and 22
focused tests passed.

Browser checks covered login, the workspace page, and the session list. The
session list fits a 320-pixel viewport. These checks did not cover a running
sandbox. The test UI is temporarily stopped because the cluster lacks memory
capacity. Live session and log checks remain pending.
