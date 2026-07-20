import { getCycleByThreadId, getCycleByWeekStart, type CycleRow } from "../db/queries";
import { weekStartOf } from "../domain/cycle";
import type { Interaction } from "../types";

// 사이클 귀속 규칙(스펙 §5.2): 스레드 안 → 그 스레드의 사이클, 채널 → 현재 주차
export async function resolveCycle(
  db: D1Database,
  interaction: Interaction,
  now: Date
): Promise<CycleRow | null> {
  const ch = interaction.channel;
  if (ch?.parent_id) return getCycleByThreadId(db, ch.id);
  return getCycleByWeekStart(db, weekStartOf(now));
}
