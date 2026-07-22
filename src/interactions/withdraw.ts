import { countSubmissionsByUser, listParticipants, removeParticipant } from "../db/queries";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { ephemeral } from "../discord/replies";
import type { Handler } from "../router";
import { getStringOption, interactionUserId } from "../types";
import { resolveCycle } from "./resolve-cycle";

export const handleWithdraw: Handler = async (interaction, deps) => {
  const now = deps.now();
  const cycle = await resolveCycle(deps.db, interaction, now);
  if (!cycle) return ephemeral("이번 주 목표가 아직 없어요.");
  if (isPastDeadline(cycle.week_start, now)) return ephemeral("이미 마감된 주차예요.");

  const target = getStringOption(interaction, "대상") ?? interactionUserId(interaction);
  const participants = await listParticipants(deps.db, cycle.id);
  if (!participants.some((p) => p.user_id === target)) {
    return ephemeral("그분은 이번 주 참여자가 아니에요.");
  }
  const submitted = (await countSubmissionsByUser(deps.db, cycle.id)).get(target) ?? 0;
  if (submitted > 0) return ephemeral("이미 인증한 글이 있어서 참여를 취소할 수 없어요.");

  await removeParticipant(deps.db, cycle.id, target);
  const label = weekLabel(cycle.week_start);
  // 공개 알림은 주차 스레드에 남긴다 (채널 깔끔 유지)
  deps.ctx.waitUntil(
    deps.api
      .sendMessage(cycle.thread_id, {
        content: `👋 <@${target}>님이 ${label} 참여를 취소했어요.`,
        allowed_mentions: { parse: [] },
      })
      .catch((err) => console.error("참여취소 공지 전송 실패:", err))
  );
  return ephemeral(`<@${target}>님을 ${label} 참여자에서 뺐어요.`);
};
