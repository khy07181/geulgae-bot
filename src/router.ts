import type { DiscordApi, Fetcher } from "./discord/api";
import { ephemeral, pong } from "./discord/replies";
import { InteractionType, type Env, type Interaction } from "./types";

export interface Deps {
  env: Env;
  db: D1Database;
  api: DiscordApi;
  ctx: ExecutionContext;
  now: () => Date;
  fetcher: Fetcher;
}

export type Handler = (interaction: Interaction, deps: Deps) => Promise<Response>;

// Task 8~12에서 핸들러가 한 항목씩 추가된다.
const commandHandlers: Record<string, Handler> = {};

// custom_id의 ':' 앞부분(prefix)으로 매칭. Task 11에서 "join"이 추가된다.
const componentHandlers: Record<string, Handler> = {};

export async function routeInteraction(interaction: Interaction, deps: Deps): Promise<Response> {
  if (interaction.type === InteractionType.PING) return pong();

  const ch = interaction.channel;
  const channelId = ch?.id ?? interaction.channel_id;
  const allowed = channelId === deps.env.CHANNEL_ID || ch?.parent_id === deps.env.CHANNEL_ID;
  if (!allowed) return ephemeral("이 봇은 인증 채널에서만 사용할 수 있어요.");

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const handler = commandHandlers[interaction.data?.name ?? ""];
    if (!handler) return ephemeral("알 수 없는 명령이에요.");
    return handler(interaction, deps);
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const prefix = (interaction.data?.custom_id ?? "").split(":")[0];
    const handler = componentHandlers[prefix];
    if (!handler) return ephemeral("만료됐거나 알 수 없는 버튼이에요.");
    return handler(interaction, deps);
  }

  return ephemeral("처리할 수 없는 요청이에요.");
}
