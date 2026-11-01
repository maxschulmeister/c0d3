# c0d3 fork

c0d3 is a fork of [T3 Code](https://github.com/pingdotgg/t3code). This file lists each change that the fork makes on top of upstream, and why. The upstream sync agent reads this file to resolve merge conflicts. Keep it current.

## Rules

- Keep each fork change small. Put fork features in new files. Change upstream files only with one-line mounts or imports.
- Add one entry for each fork change. List each upstream file that the change touches. Update the entry when its files change.
- Rebrand only what users see. Keep the internal identifiers `t3`, `T3CODE_*`, and `@t3tools/*`.
- In code that no entry covers, upstream wins.
- Merge sync PRs with a merge commit. A squash or rebase drops the upstream history, and the next sync conflicts again.

## Upstream sync

The sidebar update action starts an ordinary agent worktree thread in c0d3. It checks the newest upstream nightly tag, not upstream `main`. The thread runs `.github/upstream-sync/sync.ts` with `.github/upstream-sync/agent.md` as its instructions. The script uses the local `git` and `gh` login.

Register a source project with remotes for `maxschulmeister/c0d3` and `pingdotgg/t3code`. Remote roles come from their URLs; in this checkout they are `fork` and `origin`. Never push `origin` here. Without a validated registered source project, the sidebar disables local updates. The source-control writer model takes priority over the text-generation model. If that provider is not available at launch, the thread uses the default model. The provider does not change during a run.

The script includes `dist:desktop:dmg:arm64` in verification so the agent can resolve build failures with `--continue`. After the sync turn completes, the server validates the published commit and makes a fresh local build. This repeats the build to avoid trusting an agent-supplied artifact. Local updates require an Apple silicon Mac. Build output is in the update worktree's `.t3/c0d3-build.log`. Pending operations survive a server restart. Browser and remote clients can see status and open the thread. Only packaged c0d3 desktop on the hosting Mac can restart and install.

Restart validates the source and app contents against the build. A rolling PR must still have the built head and base, be mergeable, and have successful checks. It is merged with a merge commit and an expected-head guard. The resulting parents and tree are checked before installation. A clean direct-to-main sync needs no PR. A rejected restart shows Needs attention; check again after resolving it. The installer stages the app before shutdown, waits for the captured desktop PID to exit, retains a backup, and supports rollback. This is a local unsigned build, not a release-feed or CI update.

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

### Local sidebar update integration

- Files: `apps/server/src/desktopUpdate/LocalUpstream*.ts`, `apps/desktop/src/updates/DesktopLocalUpstreamUpdate*.ts`, `apps/web/src/components/sidebar/SidebarLocalUpstreamUpdate.tsx`, `packages/contracts/src/localUpstreamUpdate.ts`, `scripts/c0d3-install*.mjs`.
- Intent: reuse the sync script, then validate, build, and install locally. Never run the sync in the main checkout. Never accept an agent-supplied app path as a completed build. Do not add a CI workflow or use an external pi CLI.
- Upstream integration files: `apps/server/src/{server,ws,ws.test}.ts`, `apps/server/src/auth/RpcAuthorization.ts`, `apps/server/src/observability/RpcInstrumentation.ts`, `apps/server/src/environment/ServerEnvironment*.ts`; `packages/contracts/src/{index,rpc,ipc,environment,clientRpcPermissions}.ts`; `packages/client-runtime/src/rpc/client.ts`, `packages/client-runtime/src/state/{server,commandPermissions.test}.ts`; `apps/desktop/src/{main,preload}.ts`, `apps/desktop/src/ipc/{channels,DesktopIpcHandlers}.ts`, `apps/desktop/src/ipc/methods/updates.ts`; `apps/web/src/components/sidebar/SidebarChrome.tsx`; `scripts/build-desktop-artifact*.ts`.
- Keep the upstream `SidebarUpdatePill` exports for Settings and use upstream sidebar updates when the server lacks the local-update capability. Normal c0d3 builds have no hosted update feed. Package the standalone installer and retain the built `.app`.

### Visible c0d3 brand

- Intent: use c0d3 in web and desktop labels, icons, app names, and package artifacts. Keep upstream service behavior.
- Files: visible copy and assets in `apps/web/`, desktop branding and OS integration in `apps/desktop/`, `assets/c0d3/`, and the brand export/build scripts in `scripts/`.
- Compatibility: keep backend identifiers, `.t3`, `T3CODE_*`, `@t3tools/*`, t3.codes services, app IDs such as `com.t3tools.t3code`, and existing wire formats. The optional local-update capability and RPCs are additive. Do not rename compatibility identifiers during a sync.
