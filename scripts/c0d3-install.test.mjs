import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { assert, expect, it } from "vite-plus/test";

import { installC0d3 } from "./c0d3-install.mjs";

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "c0d3-install-"));
  const applicationsDirectory = NodePath.join(root, "Applications");
  const source = NodePath.join(root, "Update.app");
  const destination = NodePath.join(applicationsDirectory, "c0d3 (Beta).app");
  await NodeFSP.mkdir(source);
  await NodeFSP.mkdir(destination, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(source, "version"), "new");
  await NodeFSP.writeFile(NodePath.join(destination, "version"), "original");
  return {
    root,
    applicationsDirectory,
    source,
    destination,
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it.each(["copy", "approval"])("leaves the original app in place when %s fails", async (step) => {
  await using files = await fixture();
  await expect(
    installC0d3(
      { pid: 4321, source: files.source, destination: files.destination },
      {
        applicationsDirectory: files.applicationsDirectory,
        run: async (command, args) => {
          assert.equal(command, "/usr/bin/ditto");
          await NodeFSP.mkdir(args[1]);
          await NodeFSP.writeFile(NodePath.join(args[1], "partial"), "incomplete");
          if (step === "copy") throw new Error("staging failed");
        },
        onStaged: () => {
          throw new Error("staging failed");
        },
        isRunning: () => assert.fail("must not wait after failed staging"),
      },
    ),
  ).rejects.toThrow("staging failed");
  assert.equal(
    await NodeFSP.readFile(NodePath.join(files.destination, "version"), "utf8"),
    "original",
  );
  assert.deepEqual(await NodeFSP.readdir(files.applicationsDirectory), ["c0d3 (Beta).app"]);
});

it("stages while the desktop runs, waits for its captured PID, and keeps the previous build", async () => {
  await using files = await fixture();
  const ready = Promise.withResolvers();
  const approval = Promise.withResolvers();
  const checked = Promise.withResolvers();
  const exited = Promise.withResolvers();
  let approved = false;
  let running = true;
  let staged;
  const opened = [];
  const installing = installC0d3(
    { pid: 4321, source: files.source, destination: files.destination },
    {
      applicationsDirectory: files.applicationsDirectory,
      run: async (command, args) => {
        if (command === "/usr/bin/ditto") {
          staged = args[1];
          await NodeFSP.cp(args[0], args[1], { recursive: true });
        } else {
          assert.equal(command, "/usr/bin/open");
          opened.push(args);
        }
      },
      onStaged: () => {
        ready.resolve();
        return approval.promise;
      },
      isRunning: (pid) => {
        assert.isTrue(approved);
        assert.equal(pid, 4321);
        return running;
      },
      pause: () => {
        checked.resolve();
        return exited.promise;
      },
    },
  );
  try {
    await Promise.race([
      ready.promise,
      installing.then(() => assert.fail("must wait for install approval")),
    ]);
    assert.equal(await NodeFSP.readFile(NodePath.join(staged, "version"), "utf8"), "new");
    assert.equal(
      await NodeFSP.readFile(NodePath.join(files.destination, "version"), "utf8"),
      "original",
    );
    assert.deepEqual(opened, []);
    approved = true;
    approval.resolve();
    await checked.promise;
  } finally {
    approved = true;
    approval.resolve();
    running = false;
    exited.resolve();
    await installing;
  }
  const result = await installing;
  assert.equal(await NodeFSP.readFile(NodePath.join(files.destination, "version"), "utf8"), "new");
  assert.equal(await NodeFSP.readFile(NodePath.join(result.backup, "version"), "utf8"), "original");
  assert.equal(await NodeFSP.readFile(NodePath.join(files.source, "version"), "utf8"), "new");
  assert.deepEqual(opened, [[files.destination]]);
});

it.each([
  ["zero PID", () => ({ pid: 0 })],
  ["negative PID", () => ({ pid: -1 })],
  ["fractional PID", () => ({ pid: 1.5 })],
  ["oversized PID", () => ({ pid: 2147483648 })],
  ["string PID", () => ({ pid: "4321" })],
  ["non-app source", (files) => ({ source: NodePath.join(files.root, "Update.zip") })],
  ["relative source", () => ({ source: "Update.app" })],
  ["same paths", (files) => ({ source: files.destination })],
  [
    "other product",
    (files) => ({ destination: NodePath.join(files.applicationsDirectory, "Other.app") }),
  ],
  ["outside Applications", (files) => ({ destination: NodePath.join(files.root, "c0d3.app") })],
  [
    "nested destination",
    (files) => ({ destination: NodePath.join(files.applicationsDirectory, "nested", "c0d3.app") }),
  ],
])("rejects unsafe input: %s", async (_label, change) => {
  await using files = await fixture();
  await expect(
    installC0d3(
      { pid: 4321, source: files.source, destination: files.destination, ...change(files) },
      {
        applicationsDirectory: files.applicationsDirectory,
        run: () => assert.fail("external commands must not run"),
        isRunning: () => assert.fail("process checks must not run"),
      },
    ),
  ).rejects.toThrow(/Invalid (desktop PID|installer paths)/);
  assert.equal(
    await NodeFSP.readFile(NodePath.join(files.destination, "version"), "utf8"),
    "original",
  );
  assert.deepEqual(await NodeFSP.readdir(files.applicationsDirectory), ["c0d3 (Beta).app"]);
});

it.each([
  "source symlink",
  "destination symlink",
  "source file",
  "destination file",
  "same app alias",
  "nested source",
])("rejects unsafe filesystem paths: %s", async (kind) => {
  await using files = await fixture();
  let source = files.source;
  if (kind === "same app alias") {
    const alias = NodePath.join(files.root, "Alias");
    await NodeFSP.symlink(files.applicationsDirectory, alias);
    source = NodePath.join(alias, NodePath.basename(files.destination));
  } else if (kind === "nested source") {
    source = NodePath.join(files.destination, "Nested.app");
    await NodeFSP.mkdir(source);
  } else {
    const path = kind.startsWith("source") ? files.source : files.destination;
    if (kind.endsWith("symlink")) {
      const target = NodePath.join(files.root, "Linked.app");
      await NodeFSP.rename(path, target);
      await NodeFSP.symlink(target, path);
    } else {
      await NodeFSP.rm(path, { recursive: true });
      await NodeFSP.writeFile(path, "not a bundle");
    }
  }
  await expect(
    installC0d3(
      { pid: 4321, source, destination: files.destination },
      {
        applicationsDirectory: files.applicationsDirectory,
        run: () => assert.fail("external commands must not run"),
        isRunning: () => assert.fail("process checks must not run"),
      },
    ),
  ).rejects.toThrow("Invalid installer paths");
  assert.deepEqual(await NodeFSP.readdir(files.applicationsDirectory), ["c0d3 (Beta).app"]);
});

it.each(["missing arguments", "temporary destination"])(
  "rejects invalid CLI input: %s",
  async (kind) => {
    await using files = await fixture();
    const args = kind === "missing arguments" ? [] : ["4321", files.source, files.destination];
    const result = NodeChildProcess.spawnSync(
      NodeProcess.execPath,
      [NodeURL.fileURLToPath(new URL("./c0d3-install.mjs", import.meta.url)), ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      kind === "missing arguments" ? /Usage:/ : /Invalid installer paths/,
    );
    assert.equal(
      await NodeFSP.readFile(NodePath.join(files.destination, "version"), "utf8"),
      "original",
    );
    assert.deepEqual(await NodeFSP.readdir(files.applicationsDirectory), ["c0d3 (Beta).app"]);
  },
);

it.each(["backup", "replacement"])(
  "preserves the original app when the %s rename fails",
  async (step) => {
    await using files = await fixture();
    await expect(
      installC0d3(
        { pid: 4321, source: files.source, destination: files.destination },
        {
          applicationsDirectory: files.applicationsDirectory,
          fs: {
            ...NodeFSP,
            rename: async (from, to) => {
              if (
                (step === "backup" && from === files.destination) ||
                (step === "replacement" && from.endsWith("next.app"))
              ) {
                throw new Error("install failed");
              }
              await NodeFSP.rename(from, to);
            },
          },
          run: async (command, args) => {
            assert.equal(command, "/usr/bin/ditto");
            await NodeFSP.cp(args[0], args[1], { recursive: true });
          },
          isRunning: () => false,
        },
      ),
    ).rejects.toThrow("install failed");
    assert.equal(
      await NodeFSP.readFile(NodePath.join(files.destination, "version"), "utf8"),
      "original",
    );
    assert.deepEqual(await NodeFSP.readdir(files.applicationsDirectory), ["c0d3 (Beta).app"]);
  },
);
