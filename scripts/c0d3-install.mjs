import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

function processIsRunning(pid) {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export async function installC0d3(
  { pid, source, destination },
  {
    applicationsDirectory = "/Applications",
    fs = NodeFSP,
    run = NodeUtil.promisify(NodeChildProcess.execFile),
    isRunning = processIsRunning,
    pause = NodeTimersPromises.setTimeout,
    onStaged = () => {},
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) {
    throw new Error("Invalid desktop PID");
  }
  if (
    typeof source !== "string" ||
    typeof destination !== "string" ||
    !NodePath.isAbsolute(source) ||
    !NodePath.isAbsolute(destination)
  ) {
    throw new Error("Invalid installer paths: use absolute .app paths");
  }
  source = NodePath.resolve(source);
  destination = NodePath.resolve(destination);
  if (
    NodePath.extname(source) !== ".app" ||
    !/^c0d3(?: \((?:Beta|Nightly|Dev)\))?\.app$/.test(NodePath.basename(destination)) ||
    NodePath.dirname(destination) !== NodePath.resolve(applicationsDirectory) ||
    source === destination
  ) {
    throw new Error(
      "Invalid installer paths: use a separate source and a c0d3 app in /Applications",
    );
  }
  const [sourceInfo, destinationInfo] = await Promise.all([
    fs.lstat(source),
    fs.lstat(destination),
  ]);
  if (!sourceInfo.isDirectory() || !destinationInfo.isDirectory()) {
    throw new Error("Invalid installer paths: app bundles must be directories, not links");
  }
  const [sourceReal, destinationReal] = await Promise.all([
    fs.realpath(source),
    fs.realpath(destination),
  ]);
  if (
    sourceReal === destinationReal ||
    sourceReal.startsWith(destinationReal + NodePath.sep) ||
    destinationReal.startsWith(sourceReal + NodePath.sep)
  ) {
    throw new Error("Invalid installer paths: app bundles must be separate");
  }
  const workspace = await fs.mkdtemp(
    NodePath.join(NodePath.dirname(destination), ".c0d3-install-"),
  );
  const staged = NodePath.join(workspace, "next.app");
  let backup;
  try {
    await run("/usr/bin/ditto", [source, staged]);
    await onStaged();
    while (isRunning(pid)) await pause(250);
    const previous = NodePath.join(workspace, NodePath.basename(destination));
    await fs.rename(destination, previous);
    backup = previous;
    try {
      await fs.rename(staged, destination);
    } catch (error) {
      await fs.rename(backup, destination);
      backup = undefined;
      throw error;
    }
    await run("/usr/bin/open", [destination]);
    return { destination, backup };
  } finally {
    if (!backup) await fs.rm(workspace, { recursive: true, force: true });
  }
}

if (NodeProcess.argv[1] && NodeURL.pathToFileURL(NodeProcess.argv[1]).href === import.meta.url) {
  try {
    const args = NodeProcess.argv.slice(2);
    if (args.length !== 3) {
      throw new Error(
        "Usage: node c0d3-install.mjs <desktop-pid> <source.app> </Applications/c0d3 product.app>",
      );
    }
    const [pid, source, destination] = args;
    const result = await installC0d3(
      { pid: Number(pid), source, destination },
      {
        onStaged: NodeProcess.default.send
          ? () =>
              new Promise((resolve, reject) => {
                const cleanup = () => {
                  NodeProcess.default.off("message", onMessage);
                  NodeProcess.default.off("disconnect", onDisconnect);
                };
                const onDisconnect = () => {
                  cleanup();
                  reject(new Error("Desktop disconnected before install approval"));
                };
                const onMessage = (message) => {
                  cleanup();
                  if (message?.type !== "install") {
                    reject(new Error("Desktop did not approve installation"));
                    return;
                  }
                  resolve();
                };
                NodeProcess.default.once("message", onMessage);
                NodeProcess.default.once("disconnect", onDisconnect);
                NodeProcess.default.send({ type: "staged" }, (error) => {
                  if (!error) return;
                  cleanup();
                  reject(error);
                });
              })
          : undefined,
      },
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error);
    NodeProcess.default.exitCode = 1;
  }
}
