import { LOCAL_UPSTREAM_RESTART_PATH, LocalUpstreamRestartInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as LocalUpstreamUpdate from "./LocalUpstreamUpdate.ts";

const decodeRestart = Schema.decodeUnknownEffect(LocalUpstreamRestartInput);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* LocalUpstreamUpdate.LocalUpstreamUpdate;
    return HttpRouter.add(
      "POST",
      LOCAL_UPSTREAM_RESTART_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* decodeRestart(yield* request.json);
        const result = yield* service.restart(
          input.operationId,
          request.headers["x-c0d3-host"] ?? "",
        );
        return yield* HttpServerResponse.json(result);
      }).pipe(
        Effect.catchTags({
          LocalUpstreamUpdateError: (error) =>
            HttpServerResponse.json(
              { error: error.message },
              { status: error.stage === "hosting-desktop-required" ? 403 : 409 },
            ),
          SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
        }),
      ),
    );
  }),
);
