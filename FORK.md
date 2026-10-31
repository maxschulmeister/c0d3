# c0d3 fork

c0d3 is a fork of [T3 Code](https://github.com/pingdotgg/t3code). This file lists each change that the fork makes on top of upstream, and why. The upstream sync agent reads this file to resolve merge conflicts. Keep it current.

## Rules

- Keep each fork change small. Put fork features in new files. Change upstream files only with one-line mounts or imports.
- Add one entry for each fork change. List each upstream file that the change touches. Update the entry when its files change.
- Rebrand only what users see. Keep the internal identifiers `t3`, `T3CODE_*`, and `@t3tools/*`.
- In code that no entry covers, upstream wins.
- Merge sync PRs with a merge commit. A squash or rebase drops the upstream history, and the next sync conflicts again.

## Upstream sync

An agent thread in T3 Code (later c0d3) runs the sync. Use a worktree thread and give it `.github/upstream-sync/agent.md` as the prompt. The script uses the local `git` and `gh` login.

`.github/upstream-sync/sync.ts` merges the newest upstream nightly tag:

- It merges upstream one PR at a time. At a conflict, it stops with the merge in progress and exits with code 2. The agent resolves the conflict and runs the script with `--continue`.
- Then it runs `vp i && vp run typecheck`. On a failure, it exits with code 3. The agent fixes the fork and runs `--continue`.
- A clean result without agent work goes straight to `main`. Other results go to one rolling PR from `sync/upstream`.
- `--abort` stops a sync. To start over from `main`, delete the `sync/upstream` branch.
- A lock in the git common dir stops two worktrees from syncing at the same time.

Never run the script in the main checkout. It checks out other commits.

Upstream workflows are disabled in this fork, because they need runners that the fork does not have. After each push, the script disables new upstream workflows. Name fork workflows `fork-*.yml` so that the script keeps them.

To run the sync without push or PR:

```bash
node .github/upstream-sync/sync.ts --local --origin <fork remote> --upstream <upstream remote>
```

Tests: `node --test .github/upstream-sync/sync.test.ts`.

## Fork changes

### Upstream sync

- Files: `FORK.md`, `.github/upstream-sync/`
- Intent: keep the fork current with upstream nightlies.
- Upstream files changed: none.
