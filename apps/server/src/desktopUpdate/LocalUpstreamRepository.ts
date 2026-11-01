// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { LocalUpstreamUpdateError, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

export const Source = Schema.Struct({
  projectId: ProjectId,
  cwd: Schema.String,
  forkRemote: Schema.String,
  upstreamRemote: Schema.String,
});
export type Source = typeof Source.Type;
export const Target = Schema.Struct({ tag: Schema.String, sha: Schema.String });
export type Target = typeof Target.Type;
export const Build = Schema.Struct({
  cwd: Schema.String,
  head: Schema.String,
  base: Schema.String,
  pr: Schema.NullOr(Schema.Number),
  sourceApp: Schema.String,
  digest: Schema.String,
});
export type Build = typeof Build.Type;
const PullRequest = Schema.Struct({
  number: Schema.Number,
  headRefOid: Schema.String,
  baseRefOid: Schema.String,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  mergeable: Schema.String,
  state: Schema.String,
  mergeCommit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
  statusCheckRollup: Schema.Array(
    Schema.Struct({
      status: Schema.optional(Schema.String),
      conclusion: Schema.optional(Schema.String),
      state: Schema.optional(Schema.String),
    }),
  ),
});

const decodePullRequest = Schema.decodeEffect(Schema.fromJsonString(PullRequest));
const decodePullRequests = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(PullRequest)));

export class LocalUpstreamRepository extends Context.Service<
  LocalUpstreamRepository,
  {
    readonly source: (
      projectId: ProjectId,
      cwd: string,
    ) => Effect.Effect<Source | null, LocalUpstreamUpdateError>;
    readonly newest: (source: Source) => Effect.Effect<Target, LocalUpstreamUpdateError>;
    readonly installed: (
      build: Build,
      executable: string,
    ) => Effect.Effect<boolean, LocalUpstreamUpdateError>;
    readonly build: (
      source: Source,
      target: Target,
      cwd: string,
    ) => Effect.Effect<Build, LocalUpstreamUpdateError>;
    readonly checkRestart: (
      source: Source,
      target: Target,
      build: Build,
    ) => Effect.Effect<string, LocalUpstreamUpdateError>;
    readonly restart: (
      source: Source,
      target: Target,
      build: Build,
    ) => Effect.Effect<string, LocalUpstreamUpdateError>;
  }
>()("t3/desktopUpdate/LocalUpstreamRepository") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const environment = yield* HostProcess.Environment;
  const run = Effect.fn("LocalUpstreamRepository.run")(function* (
    cwd: string,
    command: string,
    args: string[],
    allowed = [0],
  ) {
    const result = yield* runner
      .run({
        cwd,
        command,
        args,
        env: { PATH: `${NodePath.join(cwd, "node_modules/.bin")}:${environment.PATH ?? ""}` },
        outputMode: "truncate",
        timeout: command.endsWith("/vp") ? "60 minutes" : "2 minutes",
      })
      .pipe(Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "process", cause })));
    if (command.endsWith("/vp")) {
      yield* fs
        .makeDirectory(NodePath.join(cwd, ".t3"), { recursive: true })
        .pipe(
          Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "build-log", cause })),
        );
      yield* fs
        .writeFileString(
          NodePath.join(cwd, ".t3/c0d3-build.log"),
          `${result.stdout}\n${result.stderr}`,
        )
        .pipe(
          Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "build-log", cause })),
        );
    }
    if (!allowed.includes(result.code ?? -1))
      return yield* new LocalUpstreamUpdateError({
        stage: command.endsWith("/vp") ? "build" : "process",
      });
    return result.stdout.trim();
  });
  const git = (cwd: string, ...args: string[]) => run(cwd, "git", args);
  const gh = (cwd: string, ...args: string[]) =>
    run(cwd, "gh", [...args, "--repo", "maxschulmeister/c0d3"]);
  const source: LocalUpstreamRepository["Service"]["source"] = Effect.fn(
    "LocalUpstreamRepository.source",
  )(function* (projectId, cwd) {
    const remotes = (yield* git(cwd, "remote")).split("\n").filter(Boolean);
    let forkRemote: string | undefined;
    let upstreamRemote: string | undefined;
    for (const remote of remotes) {
      if (!/^[a-zA-Z0-9_-]+$/.test(remote)) continue;
      const url = yield* git(cwd, "remote", "get-url", remote);
      const repo = /^(?:https:\/\/github\.com\/|git@github\.com:)([^\s]+?)(?:\.git)?\/?$/
        .exec(url)?.[1]
        ?.toLowerCase();
      if (repo === "maxschulmeister/c0d3") {
        const push = yield* git(cwd, "remote", "get-url", "--push", "--all", remote);
        if (push !== url) continue;
        forkRemote = remote;
      }
      if (repo === "pingdotgg/t3code") upstreamRemote = remote;
    }
    if (
      !forkRemote ||
      !upstreamRemote ||
      !(yield* fs
        .exists(NodePath.join(cwd, ".github/upstream-sync/sync.ts"))
        .pipe(Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "source", cause }))))
    )
      return null;
    return { projectId, cwd, forkRemote, upstreamRemote };
  });
  const newest = Effect.fn("LocalUpstreamRepository.newest")(function* (source: Source) {
    const lines = (yield* git(
      source.cwd,
      "ls-remote",
      "--tags",
      "--sort=-v:refname",
      source.upstreamRemote,
      "v*-nightly.*",
    )).split("\n");
    const first = lines[0]
      ?.split(/\s+/)[1]
      ?.replace(/^refs\/tags\//, "")
      .replace(/\^\{\}$/, "");
    if (!first || !/^v[0-9][a-zA-Z0-9.-]*-nightly\.[a-zA-Z0-9.-]+$/.test(first))
      return yield* new LocalUpstreamUpdateError({ stage: "nightly" });
    const peeled =
      lines.find((line) => line.endsWith(`refs/tags/${first}^{}`)) ??
      lines.find((line) => line.endsWith(`refs/tags/${first}`));
    const sha = peeled?.split(/\s+/)[0];
    if (!sha || !/^[a-f0-9]{40}$/.test(sha))
      return yield* new LocalUpstreamUpdateError({ stage: "nightly" });
    return { tag: first, sha };
  });
  const published = Effect.fn("LocalUpstreamRepository.published")(function* (
    source: Source,
    target: Target,
    cwd: string,
  ) {
    const validated = yield* sourceForWorktree(source, cwd);
    if (!validated) return yield* new LocalUpstreamUpdateError({ stage: "worktree" });
    if (yield* git(cwd, "status", "--porcelain"))
      return yield* new LocalUpstreamUpdateError({ stage: "uncommitted-source" });
    const statePath = yield* git(cwd, "rev-parse", "--git-path", "upstream-sync.json");
    if (
      yield* fs
        .exists(NodePath.resolve(cwd, statePath))
        .pipe(
          Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "sync-state", cause })),
        )
    )
      return yield* new LocalUpstreamUpdateError({ stage: "sync-incomplete" });
    yield* git(cwd, "merge-base", "--is-ancestor", target.sha, "HEAD");
    const head = yield* git(cwd, "rev-parse", "HEAD");
    const base =
      (yield* git(cwd, "ls-remote", source.forkRemote, "refs/heads/main")).split(/\s+/)[0] ?? "";
    if (!/^[a-f0-9]{40}$/.test(base))
      return yield* new LocalUpstreamUpdateError({ stage: "fork-main" });
    if (head === base) return { head, base, pr: null };
    const prs = yield* gh(
      cwd,
      "pr",
      "list",
      "--state",
      "open",
      "--head",
      "sync/upstream",
      "--base",
      "main",
      "--json",
      "number,headRefOid,baseRefOid,baseRefName,headRefName,mergeable,state,mergeCommit,statusCheckRollup",
    );
    const list = yield* decodePullRequests(prs).pipe(
      Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "pull-request", cause })),
    );
    const pr = list[0];
    if (list.length !== 1 || !pr || pr.headRefOid !== head || pr.baseRefOid !== base)
      return yield* new LocalUpstreamUpdateError({ stage: "published-head" });
    yield* git(cwd, "merge-base", "--is-ancestor", base, head);
    return { head, base, pr: pr.number };
  });
  const sourceForWorktree = Effect.fn("LocalUpstreamRepository.sourceForWorktree")(function* (
    expected: Source,
    cwd: string,
  ) {
    const validated = yield* source(expected.projectId, cwd);
    const gitDir = yield* git(cwd, "rev-parse", "--absolute-git-dir");
    const commonDir = yield* git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const expectedCommon = yield* git(
      expected.cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    return (
      validated !== null &&
      gitDir !== commonDir &&
      commonDir === expectedCommon &&
      validated.forkRemote === expected.forkRemote &&
      validated.upstreamRemote === expected.upstreamRemote
    );
  });
  const digest = Effect.fn("LocalUpstreamRepository.digest")(function* (app: string) {
    const hash = NodeCrypto.createHash("sha256");
    const visit = Effect.fn("LocalUpstreamRepository.hashDirectory")(function* (
      directory: string,
    ): Effect.fn.Return<void, LocalUpstreamUpdateError> {
      const entries = yield* fs
        .readDirectory(directory)
        .pipe(
          Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "artifact", cause })),
        );
      for (const name of entries.sort()) {
        const path = NodePath.join(directory, name);
        const link = yield* fs.readLink(path).pipe(Effect.option);
        hash.update(path.slice(app.length));
        if (Option.isSome(link)) {
          hash.update(`link:${link.value}`);
          continue;
        }
        const stat = yield* fs
          .stat(path)
          .pipe(
            Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "artifact", cause })),
          );
        hash.update(String(stat.mode));
        if (stat.type === "Directory") yield* visit(path);
        else
          hash.update(
            yield* fs
              .readFile(path)
              .pipe(
                Effect.mapError(
                  (cause) => new LocalUpstreamUpdateError({ stage: "artifact", cause }),
                ),
              ),
          );
      }
    });
    yield* visit(app);
    return hash.digest("hex");
  });
  const build = Effect.fn("LocalUpstreamRepository.build")(function* (
    source: Source,
    target: Target,
    cwd: string,
  ) {
    const publishedHead = yield* published(source, target, cwd);
    const release = NodePath.join(cwd, "release");
    yield* fs
      .remove(release, { recursive: true, force: true })
      .pipe(
        Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "build-output", cause })),
      );
    yield* run(cwd, "./node_modules/.bin/vp", ["run", "dist:desktop:dmg:arm64"]);
    const after = yield* published(source, target, cwd);
    if (
      after.head !== publishedHead.head ||
      after.base !== publishedHead.base ||
      after.pr !== publishedHead.pr
    )
      return yield* new LocalUpstreamUpdateError({ stage: "source-changed-during-build" });
    const apps = yield* fs
      .readDirectory(NodePath.join(release, "mac-arm64"))
      .pipe(Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "artifact", cause })));
    const names = apps.filter((name) => /^c0d3(?: \((?:Beta|Nightly|Dev)\))?\.app$/.test(name));
    if (names.length !== 1) return yield* new LocalUpstreamUpdateError({ stage: "artifact" });
    const sourceApp = NodePath.join(release, "mac-arm64", names[0]!);
    const bundleId = yield* run(cwd, "/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      NodePath.join(sourceApp, "Contents/Info.plist"),
    ]);
    if (bundleId !== "com.t3tools.t3code")
      return yield* new LocalUpstreamUpdateError({ stage: "artifact-identity" });
    return { ...publishedHead, cwd, sourceApp, digest: yield* digest(sourceApp) };
  });
  const validateRestart = Effect.fn("LocalUpstreamRepository.validateRestart")(function* (
    source: Source,
    target: Target,
    build: Build,
    mergePr: boolean,
  ) {
    if (
      !(yield* sourceForWorktree(source, build.cwd)) ||
      (yield* git(build.cwd, "status", "--porcelain")) ||
      (yield* git(build.cwd, "rev-parse", "HEAD")) !== build.head ||
      (yield* digest(build.sourceApp)) !== build.digest
    )
      return yield* new LocalUpstreamUpdateError({ stage: "stale-build" });
    yield* git(build.cwd, "merge-base", "--is-ancestor", target.sha, build.head);
    const main = (yield* git(build.cwd, "ls-remote", source.forkRemote, "refs/heads/main")).split(
      /\s+/,
    )[0];
    if (build.pr === null) {
      if (main !== build.head) return yield* new LocalUpstreamUpdateError({ stage: "stale-main" });
      return build.sourceApp;
    }
    const raw = yield* gh(
      build.cwd,
      "pr",
      "view",
      String(build.pr),
      "--json",
      "number,headRefOid,baseRefOid,baseRefName,headRefName,mergeable,state,mergeCommit,statusCheckRollup",
    );
    const pr = yield* decodePullRequest(raw).pipe(
      Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "pull-request", cause })),
    );
    if (
      pr.headRefOid !== build.head ||
      pr.baseRefName !== "main" ||
      pr.headRefName !== "sync/upstream"
    )
      return yield* new LocalUpstreamUpdateError({ stage: "stale-pull-request" });
    if (pr.state === "OPEN") {
      if (
        main !== build.base ||
        pr.baseRefOid !== build.base ||
        pr.mergeable !== "MERGEABLE" ||
        !pr.statusCheckRollup.every(
          (check) =>
            check.state === "SUCCESS" ||
            (check.status === "COMPLETED" &&
              ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(check.conclusion ?? "")),
        )
      )
        return yield* new LocalUpstreamUpdateError({ stage: "pull-request-not-ready" });
      if (!mergePr) return build.sourceApp;
      yield* gh(
        build.cwd,
        "pr",
        "merge",
        String(build.pr),
        "--merge",
        "--match-head-commit",
        build.head,
      );
    } else if (pr.state !== "MERGED" || pr.mergeCommit?.oid !== main)
      return yield* new LocalUpstreamUpdateError({ stage: "stale-merged-pull-request" });
    yield* git(build.cwd, "fetch", "--quiet", source.forkRemote, "main");
    const parents = yield* git(build.cwd, "show", "-s", "--format=%P", "FETCH_HEAD");
    const tree = yield* git(build.cwd, "rev-parse", "FETCH_HEAD^{tree}");
    if (
      parents !== `${build.base} ${build.head}` ||
      tree !== (yield* git(build.cwd, "rev-parse", `${build.head}^{tree}`))
    )
      return yield* new LocalUpstreamUpdateError({ stage: "merged-base-changed" });
    return build.sourceApp;
  });
  const restart = Effect.fn("LocalUpstreamRepository.restart")(
    (source: Source, target: Target, build: Build) => validateRestart(source, target, build, true),
  );
  const checkRestart = Effect.fn("LocalUpstreamRepository.checkRestart")(
    (source: Source, target: Target, build: Build) => validateRestart(source, target, build, false),
  );
  const installed = Effect.fn("LocalUpstreamRepository.installed")(function* (
    build: Build,
    executable: string,
  ) {
    const app =
      /^(\/Applications\/c0d3(?: \((?:Beta|Nightly|Dev)\))?\.app)\/Contents\/MacOS\/[^/]+$/.exec(
        executable,
      )?.[1];
    return app !== undefined && (yield* digest(app)) === build.digest;
  });
  return LocalUpstreamRepository.of({ source, newest, installed, build, checkRestart, restart });
});
export const layer = Layer.effect(LocalUpstreamRepository, make);
