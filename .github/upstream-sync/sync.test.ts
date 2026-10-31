// Run with: node --test .github/upstream-sync/sync.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(cwd: string, file: string, content: string, message: string) {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

// Upstream gets one commit per PR after the fork splits off. The fork changes
// `forkFile`; upstream PR #3 changes `shared.txt`.
function setup(forkFile: string) {
  const root = mkdtempSync(join(tmpdir(), "upstream-sync-test-"));
  const upstream = join(root, "upstream");
  const work = join(root, "work");
  git(root, "init", "--quiet", "-b", "main", upstream);
  commit(upstream, "shared.txt", "base\n", "init");
  git(root, "clone", "--quiet", "--bare", upstream, join(root, "fork.git"));
  git(root, "clone", "--quiet", join(root, "fork.git"), work);
  git(work, "remote", "add", "upstream", upstream);
  commit(work, forkFile, "fork\n", "fork change");
  git(work, "push", "--quiet", "origin", "main");

  const prs = [
    commit(upstream, "one.txt", "1\n", "feat: one (#1)"),
    commit(upstream, "two.txt", "2\n", "feat: two (#2)"),
    commit(upstream, "shared.txt", "upstream\n", "feat: three (#3)"),
    commit(upstream, "four.txt", "4\n", "feat: four (#4)"),
  ];
  git(upstream, "tag", "v0.0.1-nightly.1");
  return { root, work, prs };
}

function sync(work: string, ...args: string[]) {
  const script = join(import.meta.dirname, "sync.ts");
  const verify = args.includes("--verify") ? [] : ["--no-verify"];
  const result = spawnSync("node", [script, "--local", "--upstream-repo=", ...verify, ...args], {
    cwd: work,
    env,
    encoding: "utf8",
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

const contains = (work: string, commit: string) =>
  spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: work, env }).status === 0;
const mergeHead = (work: string) =>
  spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: work, env, encoding: "utf8" }).stdout.trim();

test("merges the newest nightly when nothing conflicts", () => {
  const { work, prs } = setup("fork.txt");
  const result = sync(work);
  assert.equal(result.status, 0, result.output);
  assert.ok(contains(work, prs[3]!));
});

test("stops at the first upstream PR that conflicts, with the merge in progress", () => {
  const { work, prs } = setup("shared.txt");
  const result = sync(work);
  assert.equal(result.status, 2, result.output);
  assert.ok(contains(work, prs[1]!));
  assert.equal(mergeHead(work), prs[2]);
  assert.match(result.output, /feat: three \(#3\)/);
  assert.match(result.output, /shared\.txt/);
});

test("--continue commits the resolution and merges the rest", () => {
  const { work, prs } = setup("shared.txt");
  assert.equal(sync(work).status, 2);
  writeFileSync(join(work, "shared.txt"), "fork and upstream\n");
  git(work, "add", "shared.txt");

  const result = sync(work, "--continue");
  assert.equal(result.status, 0, result.output);
  assert.ok(contains(work, prs[3]!));
  assert.equal(readFileSync(join(work, "shared.txt"), "utf8"), "fork and upstream\n");
  assert.equal(git(work, "status", "--porcelain", "--untracked-files=no"), "");
});

test("--continue refuses conflict markers", () => {
  const { work, prs } = setup("shared.txt");
  assert.equal(sync(work).status, 2);
  git(work, "add", "shared.txt");

  const result = sync(work, "--continue");
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /conflict markers/i);
  assert.equal(mergeHead(work), prs[2]);
});

test("a second worktree cannot sync until the first one finishes or aborts", () => {
  const { root, work } = setup("shared.txt");
  const other = join(root, "other");
  git(work, "worktree", "add", "--quiet", "--detach", other);
  assert.equal(sync(work).status, 2);

  const blocked = sync(other);
  assert.equal(blocked.status, 1, blocked.output);
  assert.match(blocked.output, /in progress/i);

  assert.equal(sync(work, "--abort").status, 0);
  assert.equal(mergeHead(work), "");
  assert.equal(sync(other).status, 2);
});

test("a failed verify stops, and --continue commits the fix and verifies again", () => {
  const { work, prs } = setup("fork.txt");
  const verify = ["--verify", "test -f ok.txt"];
  const failed = sync(work, ...verify);
  assert.equal(failed.status, 3, failed.output);
  assert.ok(contains(work, prs[3]!));

  writeFileSync(join(work, "ok.txt"), "ok\n");
  const result = sync(work, "--continue");
  assert.equal(result.status, 0, result.output);
  assert.equal(git(work, "status", "--porcelain"), "");
  assert.equal(git(work, "log", "-1", "--format=%s"), "fix: adapt fork to upstream v0.0.1-nightly.1");
});
