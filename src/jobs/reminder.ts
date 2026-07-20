import { countSubmissionsByUser, getCycleByWeekStart, listParticipants } from "../db/queries";
import { weekStartOf } from "../domain/cycle";
import type { JobDeps } from "./settle";

// 일 10:00 KST — 미달성 참여자만 멘션 (스펙 §6). 전원 달성이면 침묵.
export async function reminder(deps: JobDeps): Promise<void> {
  const now = deps.now();
  const cycle = await getCycleByWeekStart(deps.db, weekStartOf(now));
  if (!cycle) return;

  const participants = await listParticipants(deps.db, cycle.id);
  if (participants.length === 0) return;

  const counts = await countSubmissionsByUser(deps.db, cycle.id);
  const behind = participants
    .map((p) => ({ id: p.user_id, n: counts.get(p.user_id) ?? 0 }))
    .filter((p) => p.n < cycle.goal_count);
  if (behind.length === 0) return;

  await deps.api.sendMessage(cycle.thread_id, {
    content:
      `⏰ **오늘 23:59 마감!**\n` +
      behind.map((p) => `- <@${p.id}>님: 현재 ${p.n}/${cycle.goal_count}개`).join("\n"),
  });
}
