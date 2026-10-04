import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "./Manager.ts";
import * as RemoteBrowser from "./RemoteBrowser.ts";

/** A replaceable layer scope lets restart tests retain disk state without a manual runtime. */
export const makeRemoteBrowserTestHost = (root: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const services = yield* Layer.buildWithScope(
      RemoteBrowser.layer.pipe(
        Layer.provideMerge(PreviewManager.layer),
        Layer.provideMerge(ServerConfig.layerTest(root, root)),
        Layer.provideMerge(NodeServices.layer),
      ),
      scope,
    );
    return {
      browser: Context.get(services, RemoteBrowser.RemoteBrowser),
      manager: Context.get(services, PreviewManager.PreviewManager),
      config: Context.get(services, ServerConfig.ServerConfig),
      dispose: Scope.close(scope, Exit.void),
    };
  });
