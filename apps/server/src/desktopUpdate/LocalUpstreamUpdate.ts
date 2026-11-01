// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  CommandId,
  LocalUpstreamUpdateError,
  LocalUpstreamUpdateState,
  ModelSelection,
  ThreadId,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as LocalUpstreamRepository from "./LocalUpstreamRepository.ts";

const Pending = Schema.Struct({
  view: LocalUpstreamUpdateState,
  source: LocalUpstreamRepository.Source,
  target: LocalUpstreamRepository.Target,
  model: ModelSelection,
  phase: Schema.Literals(["launching", "agent", "building", "ready", "installed"]),
  build: Schema.NullOr(LocalUpstreamRepository.Build),
});
type Pending = typeof Pending.Type;
const pendingJson = Schema.fromJsonString(Pending);
const decodePending = Schema.decodeEffect(pendingJson);
const encodePending = Schema.encodeEffect(pendingJson);

export class LocalUpstreamUpdate extends Context.Service<
  LocalUpstreamUpdate,
  {
    readonly changes: Stream.Stream<LocalUpstreamUpdateState, LocalUpstreamUpdateError>;
    readonly state: Effect.Effect<LocalUpstreamUpdateState, LocalUpstreamUpdateError>;
    readonly check: Effect.Effect<LocalUpstreamUpdateState, LocalUpstreamUpdateError>;
    readonly start: Effect.Effect<LocalUpstreamUpdateState, LocalUpstreamUpdateError>;
    readonly restart: (
      operationId: string,
      hostCredential: string,
    ) => Effect.Effect<{ sourceApp: string }, LocalUpstreamUpdateError>;
  }
>()("t3/desktopUpdate/LocalUpstreamUpdate") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const repo = yield* LocalUpstreamRepository.LocalUpstreamRepository;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const executable = yield* HostProcess.ExecutablePath;
  const scope = yield* Scope.Scope;
  const mutex = yield* Semaphore.make(1);
  const path = NodePath.join(config.stateDir, "c0d3-update.json");
  const views = yield* SubscriptionRef.make<LocalUpstreamUpdateState>({
    status: "idle",
    message: "Check for updates.",
    operationId: null,
    threadId: null,
    targetTag: null,
  });
  let watchedId: string | null = null;
  const fail = (stage: string, cause?: unknown) =>
    new LocalUpstreamUpdateError({ stage, ...(cause === undefined ? {} : { cause }) });
  let stateError: LocalUpstreamUpdateError | null = null;
  const loaded = yield* Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return null;
    const raw = yield* fs.readFileString(path);
    return yield* decodePending(raw);
  }).pipe(
    Effect.mapError((cause) => fail("state", cause)),
    Effect.result,
  );
  let pending: Pending | null = loaded._tag === "Success" ? loaded.success : null;
  if (loaded._tag === "Failure") stateError = loaded.failure;
  if (pending?.phase === "building")
    pending = {
      ...pending,
      view: { ...pending.view, status: "failed", message: "Build interrupted. Retry the update." },
    };
  const save = Effect.fn("LocalUpstreamUpdate.save")(function* (next: Pending) {
    const encoded = yield* encodePending(next).pipe(
      Effect.mapError((cause) => fail("state", cause)),
    );
    yield* fs
      .writeFileString(`${path}.tmp`, encoded, { mode: 0o600 })
      .pipe(Effect.mapError((cause) => fail("state-write", cause)));
    yield* fs
      .rename(`${path}.tmp`, path)
      .pipe(Effect.mapError((cause) => fail("state-rename", cause)));
    pending = next;
    yield* SubscriptionRef.set(views, next.view);
    return next.view;
  });
  const sourceProject = Effect.fn("LocalUpstreamUpdate.sourceProject")(function* () {
    const shells = yield* projects
      .listShells()
      .pipe(Effect.mapError((cause) => fail("source", cause)));
    for (const project of shells) {
      if (project.archivedAt) continue;
      const source = yield* repo
        .source(project.id, project.workspaceRoot)
        .pipe(Effect.orElseSucceed(() => null));
      if (source !== null) return source;
    }
    return null;
  });
  const empty = (
    status: LocalUpstreamUpdateState["status"],
    message: string,
  ): LocalUpstreamUpdateState => ({
    status,
    message,
    operationId: null,
    threadId: null,
    targetTag: null,
  });
  const check = Effect.fn("LocalUpstreamUpdate.check")(function* () {
    if (stateError)
      return empty(
        "disabled",
        "Update state could not be read. Restore c0d3-update.json before starting another update.",
      );
    if (pending?.phase === "launching") return yield* launch(pending);
    if (pending?.phase === "agent") yield* follow();
    if (pending?.phase === "ready" && pending.build) {
      const result = yield* repo
        .checkRestart(pending.source, pending.target, pending.build)
        .pipe(Effect.result);
      return yield* save({
        ...pending,
        view: {
          ...pending.view,
          status: result._tag === "Success" ? "ready" : "needs-attention",
          message: result._tag === "Success" ? "Ready to restart." : result.failure.message,
        },
      });
    }
    if (pending && pending.view.status !== "failed" && pending.phase !== "installed")
      return pending.view;
    const source = yield* sourceProject();
    if (source === null)
      return empty("disabled", "Register the c0d3 fork source project to enable local updates.");
    if (platform !== "darwin" || architecture !== "arm64" || config.mode !== "desktop")
      return empty("disabled", "Local updates require c0d3 desktop on an Apple silicon Mac.");
    const target = yield* repo.newest(source);
    const installed = pending?.phase === "installed" && pending.target.sha === target.sha;
    return {
      ...empty(installed ? "idle" : "available", installed ? "Up to date." : "Update available."),
      targetTag: target.tag,
    };
  });
  const launch = Effect.fn("LocalUpstreamUpdate.launch")(function* (operation: Pending) {
    const instructions = yield* fs
      .readFileString(NodePath.join(operation.source.cwd, ".github/upstream-sync/agent.md"))
      .pipe(Effect.mapError((cause) => fail("instructions", cause)));
    const prompt = `${instructions}

This is a sidebar local update. Work only in this thread's worktree. Read FORK.md.
Put this worktree's node_modules/.bin first in PATH so the script uses the local vp.
Run:
node .github/upstream-sync/sync.ts --origin ${operation.source.forkRemote} --upstream ${operation.source.upstreamRemote} --target ${operation.target.tag} --verify 'vp i && vp run typecheck && vp run dist:desktop:dmg:arm64'

The verification includes a local build. Resolve exit 2 or 3 with --continue as described above.
Use merge commits only. Never push to the upstream remote.
Do not build separately, install, merge the rolling PR, or restart the app.
The update service makes a fresh build of the published result after this turn completes.
Do not run an external pi CLI.
`;
    const launched = yield* launcher
      .launch({
        commandId: CommandId.make(`c0d3-update:${operation.view.operationId}`),
        threadId: operation.view.threadId!,
        projectId: operation.source.projectId,
        title: `Update c0d3 to ${operation.target.tag}`,
        modelSelection: operation.model,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: {
          type: "worktree",
          branch: `sync/c0d3-local-${operation.view.operationId}`,
          baseRef: `${operation.source.forkRemote}/main`,
          startFromOrigin: true,
        },
        initialMessage: { text: prompt, attachments: [] },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError((cause) => fail("launch", cause)),
        Effect.result,
      );
    if (launched._tag === "Failure")
      return yield* save({
        ...operation,
        view: {
          ...operation.view,
          status: "needs-attention",
          message: "Thread launch failed. Check the update to retry the same thread.",
        },
      });
    const view = yield* save({ ...operation, phase: "agent" });
    yield* follow();
    return view;
  });
  const start = Effect.fn("LocalUpstreamUpdate.start")(function* () {
    if (stateError) return yield* stateError;
    if (pending?.phase === "launching") return yield* launch(pending);
    if (pending && pending.view.status !== "failed" && pending.phase !== "installed")
      return pending.view;
    const source = yield* sourceProject();
    if (
      source === null ||
      platform !== "darwin" ||
      architecture !== "arm64" ||
      config.mode !== "desktop"
    )
      return yield* fail("source");
    const target = yield* repo.newest(source);
    if (pending?.phase === "installed" && pending.target.sha === target.sha) return pending.view;
    const settings = resolveProjectSettings(
      yield* settingsService.getSettings.pipe(Effect.mapError((cause) => fail("settings", cause))),
      source.projectId,
    ).settings;
    const available = yield* providers.getProviders;
    const chosen = ServerSettings.resolveSourceControlWriterModelSelection(
      settings,
      available,
      source.projectId,
    );
    const provider = available.find((item) => item.instanceId === chosen.instanceId);
    const model =
      provider?.enabled === true &&
      isProviderAvailable(provider) &&
      resolveProjectProviderInstanceEnabled(settings, source.projectId, chosen.instanceId)
        ? chosen
        : settings.defaultModelSelection;
    if (model === null) return yield* fail("default-model-not-configured");
    const operationId = NodeCrypto.randomUUID();
    const operation: Pending = {
      source,
      target,
      model,
      phase: "launching",
      build: null,
      view: {
        ...empty("syncing", "Syncing upstream nightly."),
        operationId,
        threadId: ThreadId.make(`c0d3-update-${operationId}`),
        targetTag: target.tag,
      },
    };
    yield* save(operation);
    return yield* launch(operation);
  });
  const refresh = Effect.fn("LocalUpstreamUpdate.refresh")(function* () {
    if (!pending || pending.phase !== "agent" || !pending.view.threadId) return;
    const operation = pending;
    const { thread, runs } = yield* threads
      .getThreadRecords(pending.view.threadId, ["runs"])
      .pipe(Effect.mapError((cause) => fail("thread", cause)));
    const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    if (!latest || ["preparing", "queued", "starting", "running"].includes(latest.status)) return;
    if (latest.status !== "completed" || !thread.worktreePath) {
      yield* save({
        ...operation,
        view: {
          ...operation.view,
          status: "needs-attention",
          message: "The sync needs attention. Open the update thread.",
        },
      });
      return;
    }
    const building: Pending = {
      ...operation,
      phase: "building",
      view: { ...operation.view, status: "syncing", message: "Building the desktop app locally." },
    };
    yield* save(building);
    yield* repo.build(operation.source, operation.target, thread.worktreePath).pipe(
      Effect.flatMap((build) =>
        mutex.withPermits(1)(
          save({
            ...building,
            build,
            phase: "ready",
            view: { ...building.view, status: "ready", message: "Ready to restart." },
          }),
        ),
      ),
      Effect.catch((error) => {
        const paused = error.stage === "sync-incomplete" || error.stage === "uncommitted-source";
        return mutex.withPermits(1)(
          save({
            ...building,
            phase: paused ? "agent" : "building",
            view: {
              ...building.view,
              status: paused ? "needs-attention" : "failed",
              message: paused
                ? "Continue in the update thread, then check again."
                : `${error.message} See .t3/c0d3-build.log in the update worktree.`,
            },
          }),
        );
      }),
      Effect.catchCause((cause) =>
        Effect.logError("Local update build state could not be saved", { cause }),
      ),
      Effect.forkIn(scope),
    );
  });
  const follow = Effect.fn("LocalUpstreamUpdate.follow")(function* () {
    if (
      !pending?.view.threadId ||
      pending.phase !== "agent" ||
      watchedId === pending.view.operationId
    )
      return;
    const threadId = pending.view.threadId;
    const operationId = pending.view.operationId;
    watchedId = operationId;
    yield* Effect.gen(function* () {
      const afterSequence = yield* threads
        .getThreadEventSequence(threadId)
        .pipe(Effect.mapError((cause) => fail("thread", cause)));
      // Read after the cursor, then replay from it so a terminal event cannot be missed.
      yield* mutex.withPermits(1)(refresh());
      if (pending?.phase !== "agent") return;
      yield* threads
        .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
        .pipe(
          Stream.tap(() => mutex.withPermits(1)(refresh())),
          Stream.takeUntil(
            () => pending?.phase !== "agent" || pending.view.operationId !== operationId,
          ),
          Stream.runDrain,
        );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Local update thread watch stopped", { cause }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (watchedId === operationId) watchedId = null;
        }),
      ),
      Effect.forkIn(scope),
    );
  });
  const state = Effect.fn("LocalUpstreamUpdate.state")(function* () {
    if (stateError || !pending || pending.phase === "installed") return yield* check();
    if (pending.phase === "launching") return yield* launch(pending);
    yield* follow();
    return pending.view;
  });
  const restart = Effect.fn("LocalUpstreamUpdate.restart")(function* (
    operationId: string,
    hostCredential: string,
  ) {
    const secret = config.desktopBootstrapSecret;
    const credential = Buffer.from(hostCredential);
    const expected = Buffer.from(secret ?? "");
    if (
      platform !== "darwin" ||
      config.mode !== "desktop" ||
      !secret ||
      credential.length !== expected.length ||
      !NodeCrypto.timingSafeEqual(expected, credential)
    )
      return yield* fail("hosting-desktop-required");
    if (stateError) return yield* stateError;
    if (
      !pending ||
      pending.view.operationId !== operationId ||
      pending.view.status !== "ready" ||
      !pending.build
    )
      return yield* fail("not-ready");
    const sourceApp = yield* repo.restart(pending.source, pending.target, pending.build).pipe(
      Effect.tapError((error) =>
        save({
          ...pending!,
          view: { ...pending!.view, status: "needs-attention", message: error.message },
        }),
      ),
    );
    return { sourceApp };
  });
  if (pending?.phase === "ready" && pending.build && config.mode === "desktop") {
    yield* repo.installed(pending.build, executable).pipe(
      Effect.flatMap((installed) =>
        installed
          ? save({
              ...pending!,
              phase: "installed",
              view: { ...pending!.view, status: "idle", message: "Up to date." },
            })
          : Effect.void,
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          stateError = error;
        }),
      ),
    );
  }
  return LocalUpstreamUpdate.of({
    changes: Stream.unwrap(
      mutex
        .withPermits(1)(state().pipe(Effect.tap((view) => SubscriptionRef.set(views, view))))
        .pipe(
          Effect.map((view) => Stream.concat(Stream.succeed(view), SubscriptionRef.changes(views))),
        ),
    ),
    state: mutex.withPermits(1)(state()),
    check: mutex.withPermits(1)(
      check().pipe(Effect.tap((view) => SubscriptionRef.set(views, view))),
    ),
    start: mutex.withPermits(1)(start()),
    restart: Effect.fn("LocalUpstreamUpdate.restartAuthorized")((id, credential) =>
      mutex.withPermits(1)(restart(id, credential)),
    ),
  });
});
export const layer = Layer.effect(LocalUpstreamUpdate, make);
