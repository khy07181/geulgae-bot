import { createExecutionContext, env as testEnv } from "cloudflare:test";
import type { DiscordApi, Fetcher } from "../src/discord/api";
import type { Deps } from "../src/router";
import type { Env, Interaction, InteractionOption } from "../src/types";

export const CHANNEL_ID = "chan-1";

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: testEnv.DB,
    DISCORD_TOKEN: "test-token",
    DISCORD_PUBLIC_KEY: "unused",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_GUILD_ID: "guild-1",
    CHANNEL_ID,
    ...overrides,
  };
}

export interface ApiCall {
  method: string;
  args: unknown[];
}

export function fakeApi(): { calls: ApiCall[]; api: DiscordApi } {
  const calls: ApiCall[] = [];
  let nextId = 100;
  const api = {
    async sendMessage(channelId: string, payload: unknown) {
      calls.push({ method: "sendMessage", args: [channelId, payload] });
      return { id: String(++nextId) };
    },
    async createThread(channelId: string, messageId: string, name: string) {
      calls.push({ method: "createThread", args: [channelId, messageId, name] });
      return { id: `thread-${++nextId}` };
    },
  };
  return { calls, api: api as unknown as DiscordApi };
}

// 기본 now: 2026-07-22 수요일 낮(KST) → week_start는 2026-07-20
export const DEFAULT_NOW = new Date("2026-07-22T03:00:00Z");

export function fetcherReturning(status: number, body = ""): Fetcher {
  return async () => new Response(body, { status });
}

export function makeDeps(overrides: Partial<Deps> = {}): Deps & { calls: ApiCall[] } {
  const { calls, api } = fakeApi();
  const deps: Deps = {
    env: makeEnv(),
    db: testEnv.DB,
    api,
    ctx: createExecutionContext(),
    now: () => DEFAULT_NOW,
    fetcher: fetcherReturning(200, "<html><head><title>테스트 글</title></head><body>본문</body></html>"),
    ...overrides,
  };
  return Object.assign(deps, { calls });
}

export function makeCommandInteraction(
  name: string,
  options: InteractionOption[] = [],
  opts: { channelId?: string; parentId?: string; userId?: string } = {}
): Interaction {
  const channelId = opts.channelId ?? CHANNEL_ID;
  // 실제 디스코드에서는 카테고리에 속한 일반 채널도 parent_id(카테고리 id)를 갖는다.
  // 기본값을 카테고리 소속으로 둬서, parent_id 유무만으로 스레드를 판별하는 회귀를 테스트가 잡아내게 한다.
  const parentId = opts.parentId ?? "category-1";
  return {
    id: "inter-1",
    type: 2,
    token: "inter-token",
    channel_id: channelId,
    channel: { id: channelId, parent_id: parentId },
    member: { user: { id: opts.userId ?? "u1" } },
    data: { name, options },
  };
}

export function makeComponentInteraction(
  customId: string,
  opts: { channelId?: string; parentId?: string; userId?: string } = {}
): Interaction {
  const i = makeCommandInteraction("", [], opts);
  i.type = 3;
  i.data = { custom_id: customId };
  return i;
}

export async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}
