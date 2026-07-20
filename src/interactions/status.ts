import { countSubmissionsByUser, listParticipants } from "../db/queries";
import { formatRemaining, isPastDeadline, weekLabel } from "../domain/cycle";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Handler } from "../router";
import { resolveCycle } from "./resolve-cycle";

export const handleStatus: Handler = async (interaction, deps) => {
  const now = deps.now();
  const cycle = await resolveCycle(deps.db, interaction, now);
  if (!cycle) return ephemeral("이번 주 목표가 아직 없어요. `/목표설정`으로 시작해주세요.");

  const label = weekLabel(cycle.week_start);
  const timeNote = isPastDeadline(cycle.week_start, now)
    ? "마감됨"
    : `마감까지 ${formatRemaining(cycle.week_start, now)}`;

  const participants = await listParticipants(deps.db, cycle.id);
  if (participants.length === 0) return publicMessage(`**${label} 현황** (${timeNote})\n아직 참여자가 없어요.`);

  const counts = await countSubmissionsByUser(deps.db, cycle.id);
  const lines = participants.map((p) => {
    const n = counts.get(p.user_id) ?? 0;
    return `- <@${p.user_id}>: ${n}/${cycle.goal_count}개${n >= cycle.goal_count ? " ✅" : ""}`;
  });
  return publicMessage(`**${label} 현황** (${timeNote})\n${lines.join("\n")}`, {
    allowed_mentions: { parse: [] },
  });
};
