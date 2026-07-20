import { verifyKey } from "discord-interactions";
import { DiscordApi } from "./discord/api";
import { settleSweep, type JobDeps } from "./jobs/settle";
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

  async scheduled(event, env, _ctx): Promise<void> {
    const deps: JobDeps = {
      env,
      db: env.DB,
      api: new DiscordApi(env.DISCORD_TOKEN),
      now: () => new Date(),
    };
    try {
      switch (event.cron) {
        case "5 15 * * *": // 매일 00:05 KST — 정산 sweep
          await settleSweep(deps);
          break;
        default:
          console.log(`미연결 cron: ${event.cron}`); // Task 14에서 나머지 두 잡을 연결한다
      }
    } catch (err) {
      console.error("cron 잡 실패:", event.cron, err);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
