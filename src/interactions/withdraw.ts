import { countSubmissionsByUser, listParticipants, removeParticipant } from "../db/queries";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { ephemeral, publicMessage } from "../discord/replies";
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
  return publicMessage(`<@${target}>님을 ${weekLabel(cycle.week_start)} 참여자에서 뺐어요.`);
};
