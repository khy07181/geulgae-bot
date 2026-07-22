import { addParticipant, createCycle, getCycleByWeekStart, updateCycleSettings } from "../db/queries";
import { nextWeekStartOf, weekLabel, weekStartOf } from "../domain/cycle";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Handler } from "../router";
import { getIntegerOption, getStringOption, interactionUserId } from "../types";

export function parseMentions(text: string): string[] {
  return [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]))];
}

export const handleGoal: Handler = async (interaction, deps) => {
  const mentions = parseMentions(getStringOption(interaction, "참여자") ?? "");
  if (mentions.length === 0) {
    return ephemeral("참여자를 한 명 이상 멘션해주세요. 예: `/목표설정 참여자:@하영 @민희`");
  }
  const goalOpt = getIntegerOption(interaction, "개수");
  const penaltyOpt = getIntegerOption(interaction, "벌금");
  if (goalOpt !== null && goalOpt < 1) return ephemeral("개수는 1 이상이어야 해요.");
  if (penaltyOpt !== null && penaltyOpt < 0) return ephemeral("벌금은 0 이상이어야 해요.");

  const now = deps.now();
  const weekStart =
    (getStringOption(interaction, "주차") ?? "이번주") === "다음주"
      ? nextWeekStartOf(now)
      : weekStartOf(now);
  const label = weekLabel(weekStart);
  const nowIso = now.toISOString();

  const existing = await getCycleByWeekStart(deps.db, weekStart);
  if (!existing) {
    const goalCount = goalOpt ?? 1;
    const penaltyPerPost = penaltyOpt ?? 10000;
    const msg = await deps.api.sendMessage(deps.env.CHANNEL_ID, {
      content:
        `📝 **${label} 목표** (${weekStart} 시작)\n` +
        `목표 주당 ${goalCount}개 · 벌금 1개당 ${penaltyPerPost.toLocaleString("ko-KR")}원 · 일요일 23:59 마감`,
    });
    const thread = await deps.api.createThread(deps.env.CHANNEL_ID, msg.id, `${label} 글쓰기`);
    const cycle = await createCycle(deps.db, {
      weekStart, goalCount, penaltyPerPost,
      channelId: deps.env.CHANNEL_ID, threadId: thread.id,
      createdBy: `user:${interactionUserId(interaction)}`, createdAt: nowIso,
    });
    for (const id of mentions) await addParticipant(deps.db, cycle.id, id, "manual", nowIso);
    await deps.api.sendMessage(thread.id, {
      content:
        `${mentions.map((id) => `<@${id}>`).join(" ")}\n` +
        `${label} 목표 시작! 이 스레드에서 \`/인증\`으로 글을 인증해주세요.`,
    });
    return publicMessage(`${label} 목표를 설정했어요. 참여자 ${mentions.length}명 · 주당 ${goalCount}개.`);
  }

  await updateCycleSettings(deps.db, existing.id, {
    goalCount: goalOpt ?? undefined,
    penaltyPerPost: penaltyOpt ?? undefined,
  });
  const added: string[] = [];
  for (const id of mentions) {
    if (await addParticipant(deps.db, existing.id, id, "manual", nowIso)) added.push(id);
  }
  if (added.length > 0) {
    await deps.api.sendMessage(existing.thread_id, {
      content: `${added.map((id) => `<@${id}>`).join(" ")} ${label}에 합류했어요!`,
    });
  }
  return publicMessage(`${label} 목표를 갱신했어요. (참여자 ${added.length}명 추가)`);
};
