import { addParticipant, listParticipants } from "../db/queries";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { ephemeral } from "../discord/replies";
import type { Handler } from "../router";
import { getStringOption, interactionUserId } from "../types";
import { resolveCycle } from "./resolve-cycle";

// /참여 [대상] — 본인 또는 다른 멤버를 귀속 주차의 참여자로 등록한다.
export const handleJoin: Handler = async (interaction, deps) => {
  const now = deps.now();
  const cycle = await resolveCycle(deps.db, interaction, now);
  if (!cycle) return ephemeral("이번 주 목표가 아직 없어요. `/목표설정`을 먼저 해주세요.");
  if (isPastDeadline(cycle.week_start, now)) return ephemeral("이미 마감된 주차예요.");

  const target = getStringOption(interaction, "대상") ?? interactionUserId(interaction);
  const added = await addParticipant(deps.db, cycle.id, target, "manual", now.toISOString());
  if (!added) return ephemeral("이미 참여 중이에요.");

  const label = weekLabel(cycle.week_start);
  const count = (await listParticipants(deps.db, cycle.id)).length;
  // 공개 알림은 주차 스레드에 남긴다 (채널 깔끔 유지)
  deps.ctx.waitUntil(
    deps.api
      .sendMessage(cycle.thread_id, {
        content: `<@${target}>님이 ${label}에 참여했어요! (현재 ${count}명)`,
        allowed_mentions: { parse: [] },
      })
      .catch((err) => console.error("참여 공지 전송 실패:", err))
  );
  return ephemeral(`<@${target}>님을 ${label} 참여자로 등록했어요!`);
};
