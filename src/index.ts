import { verifyKey } from "discord-interactions";
import { DiscordApi } from "./discord/api";
import { settleSweep, type JobDeps } from "./jobs/settle";
import { fallbackNotice } from "./jobs/fallback-notice";
import { reminder } from "./jobs/reminder";
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
      // deps.fetcher(...) 호출 시 this가 deps로 바인딩되므로 전역 fetch를 직접 담으면 안 된다 (Illegal invocation)
      fetcher: (input, init) => fetch(input, init),
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
        case "1 15 * * *": // 매일 00:01 KST — 정산 sweep
          await settleSweep(deps);
          break;
        case "0 1 * * TUE": // 화 10:00 KST — 안전망 공지
          await fallbackNotice(deps);
          break;
        case "0 1 * * SUN": // 일 10:00 KST — 마감 리마인더
          await reminder(deps);
          break;
        default:
          console.log(`알 수 없는 cron: ${event.cron}`);
      }
    } catch (err) {
      console.error("cron 잡 실패:", event.cron, err);
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
