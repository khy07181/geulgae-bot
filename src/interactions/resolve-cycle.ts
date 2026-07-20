import { getCycleByThreadId, getCycleByWeekStart, type CycleRow } from "../db/queries";
import { weekStartOf } from "../domain/cycle";
import type { Interaction } from "../types";

// 사이클 귀속 규칙(스펙 §5.2): 스레드 안 → 그 스레드의 사이클, 채널 → 현재 주차
export async function resolveCycle(
  db: D1Database,
  interaction: Interaction,
  now: Date
): Promise<CycleRow | null> {
  // 스레드 안에서 실행됐다면 그 스레드의 사이클로 귀속된다.
  // channel.parent_id는 카테고리 소속 채널에서도 존재하므로 판별 근거로 쓰지 않고,
  // 채널 id가 실제 사이클 스레드인지로 판단한다 (스펙 §5.2).
  const channelId = interaction.channel?.id ?? interaction.channel_id;
  if (channelId) {
    const viaThread = await getCycleByThreadId(db, channelId);
    if (viaThread) return viaThread;
  }
  return getCycleByWeekStart(db, weekStartOf(now));
}
