import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const LocalUpstreamUpdateState = Schema.Struct({
  status: Schema.Literals([
    "unsupported",
    "disabled",
    "idle",
    "available",
    "syncing",
    "needs-attention",
    "ready",
    "failed",
  ]),
  message: Schema.String,
  operationId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  targetTag: Schema.NullOr(Schema.String),
});
export type LocalUpstreamUpdateState = typeof LocalUpstreamUpdateState.Type;

export class LocalUpstreamUpdateError extends Schema.TaggedError<LocalUpstreamUpdateError>()(
  "LocalUpstreamUpdateError",
  { stage: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return `Local update failed during ${this.stage}.`;
  }
}

export const LocalUpstreamRestartInput = Schema.Struct({ operationId: Schema.String });
export const LocalUpstreamInstall = Schema.Struct({ sourceApp: Schema.String });
export const LOCAL_UPSTREAM_RESTART_PATH = "/api/c0d3/update/restart";
