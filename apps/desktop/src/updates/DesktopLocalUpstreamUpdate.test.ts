// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopLocalUpstreamUpdate from "./DesktopLocalUpstreamUpdate.ts";

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const logDir = yield* fs.makeTempDirectoryScoped({ prefix: "c0d3-installer-test-" });
  const spawned = yield* Deferred.make<void>();
  const shutdownStarted = yield* Deferred.make<void>();
  const shutdownDone = yield* Deferred.make<void>();
  class InstallerEvents extends NodeEvents.EventEmitter {
    override once(event: string | symbol, listener: (...args: unknown[]) => void) {
      super.once(event, listener);
      if (event === "exit") Deferred.doneUnsafe(spawned, Effect.void);
      return this;
    }
  }
  const child = Object.assign(new InstallerEvents(), {
    connected: true,
    disconnect() {
      this.connected = false;
    },
    unref() {},
    send(message: unknown, callback: (error: Error | null) => void) {
      messages.push(message);
      callback(null);
      return true;
    },
  });
  const messages: unknown[] = [];
  const exits: number[] = [];
  const quitting = yield* Ref.make(false);
  const layer = DesktopLocalUpstreamUpdate.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          DesktopLocalUpstreamUpdate.InstallerSpawn,
          () => child as unknown as NodeChildProcess.ChildProcess,
        ),
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          isPackaged: true,
          platform: "darwin",
          resourcesPath: "/Applications/c0d3 (Beta).app/Contents/Resources",
          logDir,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.mock(DesktopBackendPool.DesktopBackendPool)({
          primary: Effect.succeed({
            currentConfig: Effect.succeedSome({
              bootstrap: { port: 3773, desktopBootstrapSecret: "host-secret" },
            }),
          } as never),
        }),
        Layer.mock(ElectronApp.ElectronApp)({
          exit: (code) =>
            Effect.sync(() => {
              exits.push(code);
            }),
        }),
        Layer.mock(DesktopWindow.DesktopWindow)({ flushMainWindowBounds: Effect.void }),
        Layer.succeed(DesktopState.DesktopState, {
          quitting,
        } as DesktopState.DesktopState["Service"]),
        Layer.mock(DesktopShutdown.DesktopShutdown)({
          request: Deferred.succeed(shutdownStarted, undefined).pipe(Effect.asVoid),
          awaitComplete: Deferred.await(shutdownDone),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response('{"sourceApp":"/isolated/release/mac-arm64/c0d3 (Beta).app"}', {
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return { layer, child, spawned, shutdownStarted, shutdownDone, messages, exits };
});

it.effect("keeps the desktop running until staged, then approves only after shutdown", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const service = yield* DesktopLocalUpstreamUpdate.DesktopLocalUpstreamUpdate;
      const operation = yield* service.restart("operation").pipe(Effect.forkChild);
      yield* Deferred.await(h.spawned);
      expect(h.exits).toEqual([]);
      expect(h.messages).toEqual([]);
      h.child.emit("message", { type: "staged" });
      yield* Deferred.await(h.shutdownStarted);
      expect(h.exits).toEqual([]);
      expect(h.messages).toEqual([]);
      yield* Deferred.succeed(h.shutdownDone, undefined);
      yield* Fiber.join(operation);
      expect(h.messages).toEqual([{ type: "install" }]);
      expect(h.exits).toEqual([0]);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the current app running if staging fails", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const service = yield* DesktopLocalUpstreamUpdate.DesktopLocalUpstreamUpdate;
      const operation = yield* service.restart("operation").pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(h.spawned);
      h.child.emit("exit", 1);
      expect((yield* Fiber.join(operation))._tag).toBe("Failure");
      expect(h.exits).toEqual([]);
      expect(h.messages).toEqual([]);
      expect(yield* Deferred.isDone(h.shutdownStarted)).toBe(false);
      expect(h.child.connected).toBe(false);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("cancels an interrupted quit without approving a later install", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* Effect.gen(function* () {
      const service = yield* DesktopLocalUpstreamUpdate.DesktopLocalUpstreamUpdate;
      const operation = yield* service.restart("operation").pipe(Effect.forkChild);
      yield* Deferred.await(h.spawned);
      h.child.emit("message", { type: "staged" });
      yield* Deferred.await(h.shutdownStarted);
      yield* Fiber.interrupt(operation);
      yield* Deferred.succeed(h.shutdownDone, undefined);
      expect(h.messages).toEqual([]);
      expect(h.exits).toEqual([]);
      expect(h.child.connected).toBe(false);
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
