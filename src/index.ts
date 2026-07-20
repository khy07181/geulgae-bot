import { verifyKey } from "discord-interactions";
import { DiscordApi } from "./discord/api";
import { routeInteraction, type Deps } from "./router";
import type { Env, Interaction } from "./types";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== "POST") return new Response("geulgae-bot", { status: 200 });

    const signature = request.headers.get("x-signature-ed25519");
    const timestamp = request.headers.get("x-signature-timestamp");
    const body = await request.text();
    const valid =
      signature !== null &&
      timestamp !== null &&
      (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
    if (!valid) return new Response("invalid request signature", { status: 401 });

    const interaction = JSON.parse(body) as Interaction;
    const deps: Deps = {
      env,
      db: env.DB,
      api: new DiscordApi(env.DISCORD_TOKEN),
      ctx,
      now: () => new Date(),
      fetcher: fetch,
    };
    return routeInteraction(interaction, deps);
  },
} satisfies ExportedHandler<Env>;
