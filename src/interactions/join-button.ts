import { addParticipant, getCycleByWeekStart, listParticipants } from "../db/queries";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { ephemeral, publicMessage } from "../discord/replies";
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
  return publicMessage(`<@${userId}>님이 ${weekLabel(weekStart)}에 참여했어요! (현재 ${count}명)`);
};
