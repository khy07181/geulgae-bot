import { addParticipant, listParticipants } from "../db/queries";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { deferredEphemeral, ephemeral } from "../discord/replies";
import type { Handler } from "../router";
import { getStringOption, interactionUserId } from "../types";
import { resolveCycle } from "./resolve-cycle";
import { settleDeferred } from "./silent";

// /참여 [대상] — 본인 또는 다른 멤버를 귀속 주차의 참여자로 등록한다.
// 성공 시 실행자에게는 조용히 처리하고, 공개 알림만 주차 스레드에 남긴다.
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
  deps.ctx.waitUntil(
    settleDeferred(
      deps,
      interaction,
      async () => {
        await deps.api.sendMessage(cycle.thread_id, {
          content: `<@${target}>님이 ${label}에 참여했어요! (현재 ${count}명)`,
          allowed_mentions: { parse: [] },
        });
      },
      "등록은 됐어요. 다만 스레드 알림 전송에는 실패했어요."
    )
  );
  return deferredEphemeral();
};
