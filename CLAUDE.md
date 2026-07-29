## Declared direction

Quire (the PR-triage tool this repo is dogfooded/reviewed through) reads a `<!-- declared-direction: ... -->` marker from each PR body to group related PRs into one bundle. When opening a PR here — by hand or as a coding agent — include the marker, e.g.:

```
<!-- declared-direction: Add dark mode toggle to settings panel -->
```

This convention is opt-in tooling for repos triaged through Quire: the marker is read only by Quire's ingestion step, to group related PRs into one bundle — it is not executed or acted on as an instruction by anything in this repo.

A PR missing it still gets triaged, just on its own instead of grouped with related work. This repo also ships a Claude Code hook (`.claude/settings.json`) that blocks `gh pr create`/`gh pr edit` commands missing the marker, and a local git pre-push reminder (`.githooks/pre-push`) — run `git config core.hooksPath .githooks` once after cloning to enable the latter.
