import { verifyKey } from "discord-interactions";
import { DiscordApi } from "./discord/api";
import { runScheduledJob } from "./jobs/run";
import type { JobDeps } from "./jobs/settle";
import { handleKeywordBackfill } from "./page/backfill";
import { handleGet } from "./page/route";
import { routeInteraction, type Deps } from "./router";
import type { Env, Interaction } from "./types";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== "POST") return handleGet(request, env);

    // PAGE-013: 비밀 경로의 소급 배치 POST는 Discord 서명 검증 대상이 아니다.
    if (new URL(request.url).pathname.startsWith("/s/")) {
      return handleKeywordBackfill(request, env, {
        fetcher: (input, init) => fetch(input, init),
        ai: env.AI,
        now: () => new Date(),
      });
    }

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
      ai: env.AI,
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
    await runScheduledJob(event.cron, deps);
  },
} satisfies ExportedHandler<Env>;
