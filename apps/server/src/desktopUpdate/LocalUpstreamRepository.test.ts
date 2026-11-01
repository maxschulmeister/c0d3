import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as LocalUpstreamRepository from "./LocalUpstreamRepository.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const source = {
  projectId: ProjectId.make("project"),
  cwd: "/source",
  forkRemote: "fork",
  upstreamRemote: "origin",
};
const target = { tag: "v0.1.7-nightly.20260617", sha: "d".repeat(40) };
const build = {
  cwd: "/worktree",
  head,
  base,
  pr: 1,
  sourceApp: "/worktree/release/mac-arm64/c0d3.app",
  digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};

type Scenario =
  | "ready"
  | "stale-head"
  | "stale-base"
  | "pending-check"
  | "conflict"
  | "merged"
  | "merge-race"
  | "artifact-changed"
  | "source-changed"
  | "clean-main"
  | "stale-main"
  | "build-failure"
  | "main-checkout";
const harness = (scenario: Scenario, mutations: string[]) => {
  let merged = scenario === "merged";
  const pr = {
    number: 1,
    headRefOid: scenario === "stale-head" ? merge : head,
    baseRefOid: scenario === "stale-base" ? merge : base,
    baseRefName: "main",
    headRefName: "sync/upstream",
    mergeable: scenario === "conflict" ? "CONFLICTING" : "MERGEABLE",
    statusCheckRollup: [
      { status: scenario === "pending-check" ? "IN_PROGRESS" : "COMPLETED", conclusion: "SUCCESS" },
    ],
    state: merged ? "MERGED" : "OPEN",
    mergeCommit: merged ? { oid: merge } : null,
  };
  const prJson = encodeJson(pr);
  const prsJson = encodeJson([pr]);
  const runner = Layer.mock(ProcessRunner.ProcessRunner)({
    run: (input) =>
      Effect.sync(() => {
        let stdout: string;
        const args = input.args.join(" ");
        if (input.command.endsWith("/vp"))
          return {
            stdout: "build failed",
            stderr: "",
            code: 1,
            timedOut: false,
          } as ProcessRunner.ProcessRunOutput;
        if (input.command === "gh") {
          if (args.startsWith("pr merge ")) {
            mutations.push(args);
            merged = true;
            stdout = "";
          } else stdout = args.startsWith("pr list ") ? (merged ? "[]" : prsJson) : prJson;
        } else if (args === "remote") stdout = "origin\nfork";
        else if (args.startsWith("remote get-url"))
          stdout = args.endsWith("fork")
            ? "https://github.com/maxschulmeister/c0d3.git"
            : "https://github.com/pingdotgg/t3code.git";
        else if (args === "status --porcelain" || args.startsWith("merge-base --is-ancestor"))
          stdout = "";
        else if (args === "rev-parse --absolute-git-dir")
          stdout = scenario === "main-checkout" ? "/source/.git" : "/source/.git/worktrees/update";
        else if (args === "rev-parse --path-format=absolute --git-common-dir")
          stdout = "/source/.git";
        else if (args === "rev-parse --git-path upstream-sync.json")
          stdout = "/source/.git/worktrees/update/upstream-sync.json";
        else if (args === "rev-parse HEAD") stdout = scenario === "source-changed" ? merge : head;
        else if (args === "ls-remote fork refs/heads/main")
          stdout = `${scenario === "clean-main" ? head : merged ? merge : base}\trefs/heads/main`;
        else if (args.startsWith("fetch --quiet fork main")) stdout = "";
        else if (args === "show -s --format=%P FETCH_HEAD")
          stdout = `${scenario === "merge-race" ? merge : base} ${head}`;
        else if (args.includes("^{tree}")) stdout = "same-tree";
        else if (args === "ls-remote --tags --sort=-v:refname origin v*-nightly.*")
          stdout = `${target.sha}\trefs/tags/${target.tag}^{}\n${head}\trefs/tags/${target.tag}\n${base}\trefs/tags/v0.1.7-nightly.20260616`;
        else throw new Error(`Unexpected fixture command: ${args}`);
        return {
          stdout,
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        } as ProcessRunner.ProcessRunOutput;
      }),
  });
  return LocalUpstreamRepository.layer.pipe(
    Layer.provide(runner),
    Layer.provide(
      FileSystem.layerNoop({
        exists: (path) => Effect.succeed(path.endsWith("sync.ts")),
        readDirectory: () => Effect.succeed([]),
        remove: () => Effect.void,
        makeDirectory: () => Effect.void,
        writeFileString: () => Effect.void,
      }),
    ),
  );
};

it.effect.each<Scenario>([
  "ready",
  "stale-head",
  "stale-base",
  "pending-check",
  "conflict",
  "merged",
  "merge-race",
  "artifact-changed",
  "source-changed",
  "clean-main",
  "stale-main",
  "main-checkout",
])("restart validates the built PR and live GitHub state: %s", (scenario) => {
  const mutations: string[] = [];
  return Effect.gen(function* () {
    const repo = yield* LocalUpstreamRepository.LocalUpstreamRepository;
    const result = yield* repo
      .restart(source, target, {
        ...build,
        ...(scenario === "artifact-changed" ? { digest: "changed" } : {}),
        ...(scenario === "clean-main" || scenario === "stale-main" ? { pr: null } : {}),
      })
      .pipe(Effect.result);
    if (scenario === "ready" || scenario === "merged" || scenario === "clean-main") {
      expect(result).toMatchObject({ _tag: "Success", success: build.sourceApp });
    } else {
      expect(result._tag).toBe("Failure");
    }
    expect(mutations.length).toBe(scenario === "ready" || scenario === "merge-race" ? 1 : 0);
    if (mutations.length > 0)
      expect(mutations[0]).toContain(
        `--merge --match-head-commit ${head} --repo maxschulmeister/c0d3`,
      );
  }).pipe(Effect.provide(harness(scenario, mutations)));
});

it.effect("does not mark an old app ready when the local build exits with a failure", () =>
  Effect.gen(function* () {
    const repo = yield* LocalUpstreamRepository.LocalUpstreamRepository;
    expect((yield* repo.build(source, target, build.cwd).pipe(Effect.flip)).stage).toBe("build");
  }).pipe(Effect.provide(harness("build-failure", []))),
);

it.effect("discovers remote roles from URLs and checks only upstream nightly tags", () =>
  Effect.gen(function* () {
    const repo = yield* LocalUpstreamRepository.LocalUpstreamRepository;
    expect(yield* repo.source(source.projectId, source.cwd)).toEqual(source);
    expect(yield* repo.newest(source)).toEqual(target);
  }).pipe(Effect.provide(harness("ready", []))),
);
