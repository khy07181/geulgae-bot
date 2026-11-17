export interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_GUILD_ID: string;
  CHANNEL_ID: string;
  // PAGE-003: 서재 비밀 경로 토큰(wrangler secret). 미설정이면 서재 경로는 404로 닫힌다.
  PAGE_TOKEN?: string;
}

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

export interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
}

export interface Interaction {
  id: string;
  type: number;
  token: string;
  channel_id?: string;
  channel?: { id: string; parent_id?: string };
  member?: { user: { id: string } };
  user?: { id: string };
  data?: { name?: string; custom_id?: string; options?: InteractionOption[] };
}

export function interactionUserId(i: Interaction): string {
  const id = i.member?.user.id ?? i.user?.id;
  if (!id) throw new Error("인터랙션에 유저 정보가 없음");
  return id;
}

export function getStringOption(i: Interaction, name: string): string | null {
  const opt = i.data?.options?.find((o) => o.name === name);
  return typeof opt?.value === "string" ? opt.value : null;
}

export function getIntegerOption(i: Interaction, name: string): number | null {
  const opt = i.data?.options?.find((o) => o.name === name);
  return typeof opt?.value === "number" ? opt.value : null;
}
