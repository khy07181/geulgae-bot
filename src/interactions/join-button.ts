import { addParticipant, getCycleByWeekStart, listParticipants } from "../db/queries";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { ephemeral } from "../discord/replies";
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
  // 참여 공지는 채널이 아니라 그 주차 스레드에 남긴다 — 채널을 깔끔하게 유지하고
  // 주차별 대화가 스레드 안에서 시작·마무리되도록.
  deps.ctx.waitUntil(
    deps.api
      .sendMessage(cycle.thread_id, {
        content: `<@${userId}>님이 ${weekLabel(weekStart)}에 참여했어요! (현재 ${count}명)`,
        allowed_mentions: { parse: [] },
      })
      .catch((err) => console.error("참여 공지 전송 실패:", err))
  );
  return ephemeral(`${weekLabel(weekStart)} 참여 완료! 글을 쓰면 스레드에서 \`/인증\`으로 인증해주세요.`);
};
