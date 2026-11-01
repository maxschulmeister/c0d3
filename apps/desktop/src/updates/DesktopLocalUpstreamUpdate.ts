// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodePath from "node:path";
import {
  LOCAL_UPSTREAM_RESTART_PATH,
  LocalUpstreamInstall,
  LocalUpstreamUpdateError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

type InstallerChild = Pick<
  NodeChildProcess.ChildProcess,
  "once" | "off" | "send" | "unref" | "disconnect" | "connected"
>;
export const InstallerSpawn = Context.Reference<
  (executable: string, args: string[], options: NodeChildProcess.SpawnOptions) => InstallerChild
>("@t3tools/desktop/updates/InstallerSpawn", { defaultValue: () => NodeChildProcess.spawn });

export class DesktopLocalUpstreamUpdate extends Context.Service<
  DesktopLocalUpstreamUpdate,
  {
    readonly restart: (operationId: string) => Effect.Effect<void, LocalUpstreamUpdateError>;
  }
>()("@t3tools/desktop/updates/DesktopLocalUpstreamUpdate") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const http = yield* HttpClient.HttpClient;
  const app = yield* ElectronApp.ElectronApp;
  const shutdown = yield* DesktopShutdown.DesktopShutdown;
  const window = yield* DesktopWindow.DesktopWindow;
  const state = yield* DesktopState.DesktopState;
  const spawn = yield* InstallerSpawn;
  const mutex = yield* Semaphore.make(1);
  let installing = false;
  const restart = Effect.fn("DesktopLocalUpstreamUpdate.restart")(function* (operationId: string) {
    if (installing) return yield* new LocalUpstreamUpdateError({ stage: "install-in-progress" });
    const destination = NodePath.dirname(NodePath.dirname(environment.resourcesPath));
    if (
      !environment.isPackaged ||
      environment.platform !== "darwin" ||
      !/^\/Applications\/c0d3(?: \((?:Beta|Nightly|Dev)\))?\.app$/.test(destination)
    )
      return yield* new LocalUpstreamUpdateError({ stage: "hosting-desktop-required" });
    const backend = yield* pool.primary;
    const config = yield* backend.currentConfig;
    if (Option.isNone(config) || !config.value.bootstrap.desktopBootstrapSecret)
      return yield* new LocalUpstreamUpdateError({ stage: "local-backend" });
    const base = new URL(`http://127.0.0.1:${config.value.bootstrap.port}`);
    const request = yield* HttpClientRequest.post(new URL(LOCAL_UPSTREAM_RESTART_PATH, base)).pipe(
      HttpClientRequest.setHeader("x-c0d3-host", config.value.bootstrap.desktopBootstrapSecret),
      HttpClientRequest.schemaBodyJson(Schema.Struct({ operationId: Schema.String }))({
        operationId,
      }),
      Effect.mapError((cause) => new LocalUpstreamUpdateError({ stage: "restart-request", cause })),
    );
    const response = yield* http.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(
        (cause) => new LocalUpstreamUpdateError({ stage: "restart-authorization", cause }),
      ),
    );
    const { sourceApp } = yield* HttpClientResponse.schemaBodyJson(LocalUpstreamInstall)(
      response,
    ).pipe(
      Effect.mapError(
        (cause) => new LocalUpstreamUpdateError({ stage: "restart-response", cause }),
      ),
    );
    installing = true;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* Effect.try({
          try: () => {
            NodeFS.mkdirSync(environment.logDir, { recursive: true });
            const fd = NodeFS.openSync(
              NodePath.join(environment.logDir, "c0d3-install.log"),
              "a",
              0o600,
            );
            try {
              return spawn(
                NodeProcess.execPath,
                [
                  NodePath.join(environment.resourcesPath, "c0d3-install.mjs"),
                  String(NodeProcess.pid),
                  sourceApp,
                  destination,
                ],
                {
                  detached: true,
                  env: { ...NodeProcess.env, ELECTRON_RUN_AS_NODE: "1" },
                  stdio: ["ignore", fd, fd, "ipc"],
                },
              );
            } finally {
              NodeFS.closeSync(fd);
            }
          },
          catch: (cause) => new LocalUpstreamUpdateError({ stage: "installer-spawn", cause }),
        });
        let approved = false;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!approved && child.connected) child.disconnect();
          }),
        );
        yield* Effect.callback<void, LocalUpstreamUpdateError>((resume) => {
          const onMessage = (message: unknown) => {
            if (
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "staged"
            )
              resume(Effect.void);
          };
          const onError = (cause: unknown) =>
            resume(Effect.fail(new LocalUpstreamUpdateError({ stage: "installer-stage", cause })));
          const onExit = () => onError(undefined);
          child.once("message", onMessage);
          child.once("error", onError);
          child.once("exit", onExit);
          return Effect.sync(() => {
            child.off("message", onMessage);
            child.off("error", onError);
            child.off("exit", onExit);
          });
        });
        // Use the same non-cancellable exit as desktop relaunch, only after staging and shutdown.
        yield* window.flushMainWindowBounds;
        yield* shutdown.request;
        yield* shutdown.awaitComplete;
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* Effect.callback<void, LocalUpstreamUpdateError>((resume) => {
              if (!child.send || !child.connected)
                return resume(
                  Effect.fail(new LocalUpstreamUpdateError({ stage: "installer-approval" })),
                );
              child.send({ type: "install" }, (error) =>
                resume(
                  error
                    ? Effect.fail(
                        new LocalUpstreamUpdateError({ stage: "installer-approval", cause: error }),
                      )
                    : Effect.void,
                ),
              );
            });
            approved = true;
            child.unref();
            if (child.connected) child.disconnect();
            yield* Ref.set(state.quitting, true);
            yield* app.exit(0);
          }),
        );
      }),
    ).pipe(
      Effect.timeout("2 minutes"),
      Effect.catchTags({
        TimeoutError: (cause) =>
          Effect.fail(new LocalUpstreamUpdateError({ stage: "installer-timeout", cause })),
      }),
      Effect.onError(() =>
        Effect.sync(() => {
          installing = false;
        }),
      ),
    );
  });
  return DesktopLocalUpstreamUpdate.of({
    restart: Effect.fn("DesktopLocalUpstreamUpdate.restartSerialized")((id: string) =>
      mutex.withPermits(1)(restart(id)),
    ),
  });
});
export const layer = Layer.effect(DesktopLocalUpstreamUpdate, make);
