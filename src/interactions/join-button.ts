import { addParticipant, getCycleByWeekStart, listParticipants } from "../db/queries";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { deferredUpdate, ephemeral } from "../discord/replies";
import type { Handler } from "../router";
import { interactionUserId } from "../types";

export const handleJoinButton: Handler = async (interaction, deps) => {
  const weekStart = (interaction.data?.custom_id ?? "").slice("join:".length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return ephemeral("잘못된 버튼이에요.");

  const now = deps.now();
  if (isPastDeadline(weekStart, now)) return ephemeral("이미 마감된 주차예요.");
  const cycle = await getCycleByWeekStart(deps.db, weekStart);
  if (!cycle) return ephemeral("해당 주차 목표를 찾을 수 없어요.");

  const userId = interactionUserId(interaction);
  const added = await addParticipant(deps.db, cycle.id, userId, "button", now.toISOString());
  if (!added) return ephemeral("이미 참여 중이에요.");

  const count = (await listParticipants(deps.db, cycle.id)).length;
  // 참여 공지는 그 주차 스레드에만 남기고, 누른 본인에게는 아무 메시지도 띄우지 않는다(타입 6 무응답 ACK).
  deps.ctx.waitUntil(
    deps.api
      .sendMessage(cycle.thread_id, {
        content: `<@${userId}>님이 ${weekLabel(weekStart)}에 참여했어요! (현재 ${count}명)`,
        allowed_mentions: { parse: [] },
      })
      .catch((err) => console.error("참여 공지 전송 실패:", err))
  );
  return deferredUpdate();
};
