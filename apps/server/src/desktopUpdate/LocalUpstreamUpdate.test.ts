import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  LocalUpstreamUpdateError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as LocalUpstreamUpdate from "./LocalUpstreamUpdate.ts";
import * as LocalUpstreamRepository from "./LocalUpstreamRepository.ts";

const selection = (name: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(name),
  model: `${name}-model`,
});
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  defaultModelSelection: selection("default"),
  sourceControlWriterModelSelection: selection("writer"),
  textGenerationModelSelection: selection("text"),
  providerInstances: Object.fromEntries(
    ["writer", "text", "default"].map((name) => [
      name,
      { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
    ]),
  ),
};
const provider = (name: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(name),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-06-17T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
});
const built: LocalUpstreamRepository.Build = {
  cwd: "/source-worktree",
  sourceApp: "/source-worktree/release/mac-arm64/c0d3.app",
  head: "a".repeat(40),
  base: "b".repeat(40),
  pr: null,
  digest: "digest",
};

const harness = (
  options: {
    registered?: boolean;
    launched?: ThreadLaunch.ThreadLaunchInput[];
    build?: Effect.Effect<LocalUpstreamRepository.Build, LocalUpstreamUpdateError>;
    runStatus?: "completed" | "failed";
    resumed?: Deferred.Deferred<void>;
    readyProviders?: ServerProvider[];
    files?: Map<string, string>;
    installed?: boolean;
    restart?: Effect.Effect<string, LocalUpstreamUpdateError>;
  } = {},
) => {
  const files = options.files ?? new Map<string, string>();
  const config = ServerConfig.layerTest("/test", "/test/state").pipe(
    Layer.provide(
      FileSystem.layerNoop({ makeDirectory: () => Effect.void, chmod: () => Effect.void }),
    ),
    Layer.provide(Path.layer),
  );
  return LocalUpstreamUpdate.layer.pipe(
    Layer.provide(
      Layer.mock(LocalUpstreamRepository.LocalUpstreamRepository)({
        source: () =>
          Effect.succeed(
            options.registered
              ? {
                  projectId: ProjectId.make("source"),
                  cwd: "/source",
                  forkRemote: "fork",
                  upstreamRemote: "origin",
                }
              : null,
          ),
        newest: () => Effect.succeed({ tag: "v0.1.7-nightly.20260617", sha: "a".repeat(40) }),
        installed: () => Effect.succeed(options.installed ?? false),
        build: () => options.build ?? Effect.never,
        checkRestart: () => Effect.succeed(built.sourceApp),
        restart: () => options.restart ?? Effect.succeed(built.sourceApp),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        listShells: () =>
          Effect.succeed(
            options.registered
              ? [
                  {
                    id: ProjectId.make("source"),
                    title: "c0d3",
                    workspaceRoot: "/source",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-06-17T00:00:00.000Z",
                    updatedAt: "2026-06-17T00:00:00.000Z",
                  },
                ]
              : [],
          ),
      }),
    ),
    Layer.provide(
      FileSystem.layerNoop({
        exists: (path) => Effect.succeed(files.has(path)),
        writeFileString: (path, data) =>
          Effect.sync(() => {
            files.set(path, data);
          }),
        rename: (from, to) =>
          Effect.sync(() => {
            files.set(to, files.get(from)!);
            files.delete(from);
          }),
        readFileString: (path) =>
          Effect.succeed(files.get(path) ?? "Read FORK.md and run the sync script."),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSettings.ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(options.readyProviders ?? []),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => {
            options.launched?.push(input);
            return { threadId: input.threadId!, projection: undefined as never, resumed: false };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadEventSequence: () => Effect.succeed(0),
        streamStoredEventsFrom: () =>
          options.resumed
            ? Stream.fromEffect(Deferred.await(options.resumed)).pipe(Stream.as(undefined as never))
            : Stream.never,
        getThreadRecords: () =>
          Effect.gen(function* () {
            const resumed = options.resumed ? yield* Deferred.isDone(options.resumed) : false;
            return {
              thread: { worktreePath: "/source-worktree" },
              runs: [
                { status: resumed ? "completed" : (options.runStatus ?? "completed"), ordinal: 1 },
              ],
            } as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(
          Effect.provide(config),
          Effect.map((value) => ({
            ...value,
            mode: "desktop" as const,
            desktopBootstrapSecret: "test-host",
          })),
        ),
      ),
    ),
    Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
    Layer.provide(Layer.succeed(HostProcess.Architecture, "arm64")),
  );
};

const ready = Effect.gen(function* () {
  const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
  yield* service.start;
  return Option.getOrThrow(
    yield* service.changes.pipe(
      Stream.filter((state) => state.status === "ready"),
      Stream.runHead,
    ),
  );
});

describe("LocalUpstreamUpdate", () => {
  it.effect("builds the completed sync and reports a failed build without losing the thread", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<
        LocalUpstreamRepository.Build,
        LocalUpstreamUpdateError
      >();
      yield* Effect.gen(function* () {
        const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
        const started = yield* service.start;
        const failure = yield* service.changes.pipe(
          Stream.filter((state) => state.status === "failed"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Deferred.fail(release, new LocalUpstreamUpdateError({ stage: "build" }));
        expect(Option.getOrThrow(yield* Fiber.join(failure))).toMatchObject({
          status: "failed",
          threadId: started.threadId,
        });
      }).pipe(Effect.provide(harness({ registered: true, build: Deferred.await(release) })));
    }),
  );
  it.effect.each(["writer", "text", "default"])(
    "selects %s at launch without changing provider mid-run or creating a second sync",
    (expected) => {
      const launched: ThreadLaunch.ThreadLaunchInput[] = [];
      return Effect.gen(function* () {
        const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
        const [first, second] = yield* Effect.all([service.start, service.start], {
          concurrency: "unbounded",
        });
        expect(second.operationId).toBe(first.operationId);
        expect(launched).toHaveLength(1);
        expect(launched[0]).toMatchObject({
          modelSelection: selection(expected),
          workspaceStrategy: {
            type: "worktree",
            branch: `sync/c0d3-local-${first.operationId}`,
            baseRef: "fork/main",
            startFromOrigin: true,
          },
        });
        expect(launched[0]?.initialMessage?.text).toContain("--origin fork --upstream origin");
      }).pipe(
        Effect.provide(
          harness({
            registered: true,
            launched,
            readyProviders:
              expected === "writer"
                ? [provider("writer"), provider("text")]
                : expected === "text"
                  ? [provider("text")]
                  : [],
          }),
        ),
      );
    },
  );
  it.effect.each(["failed-run", "sync-incomplete", "uncommitted-source"])(
    "keeps a paused sync in the same thread and can resume it: %s",
    (reason) =>
      Effect.gen(function* () {
        const resumed = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
          const started = yield* service.start;
          const state = Option.getOrThrow(
            yield* service.changes.pipe(
              Stream.filter(
                (view) => view.status === "needs-attention" || view.status === "failed",
              ),
              Stream.runHead,
            ),
          );
          expect(state).toMatchObject({ status: "needs-attention", threadId: started.threadId });
          expect((yield* service.start).operationId).toBe(started.operationId);
          yield* Deferred.succeed(resumed, undefined);
          yield* service.check;
          const ready = Option.getOrThrow(
            yield* service.changes.pipe(
              Stream.filter((view) => view.status === "ready"),
              Stream.runHead,
            ),
          );
          expect(ready.operationId).toBe(started.operationId);
          expect(ready.threadId).toBe(started.threadId);
        }).pipe(
          Effect.provide(
            harness({
              registered: true,
              runStatus: reason === "failed-run" ? "failed" : "completed",
              resumed,
              build: Effect.gen(function* () {
                if (yield* Deferred.isDone(resumed)) return built;
                if (reason === "failed-run")
                  return yield* Effect.die("must not build a failed run");
                return yield* new LocalUpstreamUpdateError({ stage: reason });
              }),
            }),
          ),
        );
      }),
  );
  it.effect(
    "recovers the built operation after server restart and authorizes only the hosting desktop and matching operation",
    () =>
      Effect.gen(function* () {
        const files = new Map<string, string>();
        const result = yield* ready.pipe(
          Effect.provide(harness({ registered: true, files, build: Effect.succeed(built) })),
        );
        yield* Effect.gen(function* () {
          const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
          expect(yield* service.state).toMatchObject({
            status: "ready",
            threadId: result.threadId,
          });
          expect(
            (yield* service.restart(result.operationId!, "browser").pipe(Effect.flip)).stage,
          ).toBe("hosting-desktop-required");
          expect(
            (yield* service.restart("stale-operation", "test-host").pipe(Effect.flip)).stage,
          ).toBe("not-ready");
          expect(yield* service.restart(result.operationId!, "test-host")).toEqual({
            sourceApp: built.sourceApp,
          });
        }).pipe(Effect.provide(harness({ registered: true, files })));
        yield* Effect.gen(function* () {
          const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
          expect((yield* service.state).status).toBe("idle");
        }).pipe(Effect.provide(harness({ registered: true, files, installed: true })));
      }),
  );
  it.effect(
    "shows needs attention for rejected restart and can check again without a second build",
    () =>
      Effect.gen(function* () {
        const result = yield* ready;
        const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
        yield* service.restart(result.operationId!, "test-host").pipe(Effect.option);
        expect((yield* service.state).status).toBe("needs-attention");
        expect((yield* service.check).status).toBe("ready");
      }).pipe(
        Effect.provide(
          harness({
            registered: true,
            build: Effect.succeed(built),
            restart: Effect.fail(new LocalUpstreamUpdateError({ stage: "stale-build" })),
          }),
        ),
      ),
  );
  it.effect("checks the upstream nightly for a validated registered fork", () =>
    Effect.gen(function* () {
      const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
      const updates = yield* service.changes.pipe(Stream.take(2), Stream.runCollect);
      expect(updates.map((state) => state.status)).toEqual(["available", "available"]);
      expect(yield* service.check).toMatchObject({
        status: "available",
        targetTag: "v0.1.7-nightly.20260617",
      });
    }).pipe(Effect.provide(harness({ registered: true }))),
  );
  it.effect(
    "keeps corrupt pending state disabled without preventing server startup or starting a second sync",
    () =>
      Effect.gen(function* () {
        const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
        expect((yield* service.state).status).toBe("disabled");
        expect((yield* service.start.pipe(Effect.flip)).stage).toBe("state");
      }).pipe(
        Effect.provide(
          harness({
            registered: true,
            files: new Map([["/test/state/userdata/c0d3-update.json", "{"]]),
          }),
        ),
      ),
  );
  it.effect("disables update without a registered fork source project", () =>
    Effect.gen(function* () {
      const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
      expect((yield* service.check).status).toBe("disabled");
      expect(yield* service.start.pipe(Effect.option)).toEqual(Option.none());
    }).pipe(Effect.provide(harness())),
  );
});
