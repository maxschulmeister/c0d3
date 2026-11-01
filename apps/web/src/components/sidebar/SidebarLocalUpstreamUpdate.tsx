import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { readPrimaryEnvironmentTarget } from "../../environments/primary/target";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

export function SidebarLocalUpstreamUpdate() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const config = useAtomValue(primaryServerConfigAtom);
  if (environmentId === null || config?.environment.capabilities.localUpstreamUpdate !== true)
    return <SidebarUpdatePill />;
  return <LocalUpdate environmentId={environmentId} />;
}

function LocalUpdate({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    serverEnvironment.localUpstreamUpdate({ environmentId, input: {} }),
  );
  const checkAllowed = useAtomValue(
    serverEnvironment.checkLocalUpstreamUpdate.permissionAtom(environmentId),
  );
  const startAllowed = useAtomValue(
    serverEnvironment.startLocalUpstreamUpdate.permissionAtom(environmentId),
  );
  const check = useAtomCommand(serverEnvironment.checkLocalUpstreamUpdate);
  const start = useAtomCommand(serverEnvironment.startLocalUpstreamUpdate);
  const [busy, setBusy] = useState(false);
  const state = query.data;
  const shell = window.desktopBridge;
  const canRestart =
    !!shell?.restartLocalUpstreamUpdate &&
    readPrimaryEnvironmentTarget()?.source === "desktop-managed" &&
    shell.getClientPlatform() === "darwin" &&
    shell.getLocalEnvironmentEnabled();
  const label =
    query.error && !state
      ? "Retry check"
      : state?.status === "available"
        ? "Update"
        : state?.status === "ready"
          ? "Restart"
          : state?.status === "syncing"
            ? "Syncing"
            : state?.status === "needs-attention"
              ? "Needs attention"
              : state?.status === "failed"
                ? "Retry update"
                : "Check for updates";
  const disabled =
    busy ||
    (!state
      ? !query.error || !checkAllowed
      : state.status === "disabled" ||
        state.status === "unsupported" ||
        state.status === "syncing" ||
        (state.status === "ready"
          ? !canRestart || !checkAllowed
          : state.status === "available" || state.status === "failed"
            ? !startAllowed
            : !checkAllowed));
  const detail =
    state?.status === "ready" && !canRestart
      ? "Restart from c0d3 desktop on the hosting Mac."
      : (state?.message ?? query.error ?? "Loading update status.");
  const act = async () => {
    if (disabled) return;
    if (!state) {
      query.refresh();
      return;
    }
    setBusy(true);
    if (state.status === "ready" && state.operationId && shell?.restartLocalUpstreamUpdate) {
      const result = await settlePromise(() =>
        shell.restartLocalUpstreamUpdate!(state.operationId!),
      );
      if (result._tag === "Failure")
        toastManager.add({
          type: "error",
          title: "Restart failed",
          description: "The current app is still installed. Open the update thread for details.",
        });
    } else if (state.status === "available" || state.status === "failed") {
      await start({ environmentId, input: {} });
    } else {
      await check({ environmentId, input: {} });
    }
    setBusy(false);
  };
  return (
    <SidebarMenuItem className="ms-auto min-w-0">
      <div className="flex items-center gap-1">
        {state?.threadId ? (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: state.threadId }}
            className="rounded-sm text-xs underline outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            Update thread
          </Link>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void act()}
                  aria-label={label}
                >
                  {label}
                </Button>
              </span>
            }
          />
          <TooltipPopup side="top">{detail}</TooltipPopup>
        </Tooltip>
        <span role="status" className="sr-only">
          {detail}
        </span>
      </div>
    </SidebarMenuItem>
  );
}
