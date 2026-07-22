import { addParticipant, createCycle, getCycleByWeekStart, updateCycleSettings } from "../db/queries";
import { nextWeekStartOf, weekLabel, weekStartOf } from "../domain/cycle";
import { deferredEphemeral, ephemeral } from "../discord/replies";
import type { Handler } from "../router";
import { getIntegerOption, getStringOption, interactionUserId } from "../types";
import { settleDeferred } from "./silent";

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
    // 목표 공지(채널) 자체가 공개 기록이므로 별도의 성공 응답은 남기지 않는다(조용한 처리).
    // REST 3회 호출을 응답 이후로 미뤄 3초 규칙 부담도 없앤다.
    deps.ctx.waitUntil(
      settleDeferred(
        deps,
        interaction,
        async () => {
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
        },
        `${label} 목표 생성에 실패했어요. 잠시 후 다시 시도해주세요.`
      )
    );
    return deferredEphemeral();
  }

  await updateCycleSettings(deps.db, existing.id, {
    goalCount: goalOpt ?? undefined,
    penaltyPerPost: penaltyOpt ?? undefined,
  });
  const added: string[] = [];
  for (const id of mentions) {
    if (await addParticipant(deps.db, existing.id, id, "manual", nowIso)) added.push(id);
  }

  const changes: string[] = [];
  if (added.length > 0) {
    changes.push(`${added.map((id) => `<@${id}>`).join(" ")} ${label}에 합류했어요!`);
  }
  if (goalOpt !== null || penaltyOpt !== null) {
    const goalCount = goalOpt ?? existing.goal_count;
    const penaltyPerPost = penaltyOpt ?? existing.penalty_per_post;
    changes.push(`⚙️ 설정 갱신: 주당 ${goalCount}개 · 벌금 1개당 ${penaltyPerPost.toLocaleString("ko-KR")}원`);
  }
  // 실제로 바뀐 게 없으면 조용히 지나가는 대신 실행자에게만 알려준다 (유의미한 피드백).
  if (changes.length === 0) return ephemeral("추가된 참여자도 변경된 설정도 없어요.");

  deps.ctx.waitUntil(
    settleDeferred(
      deps,
      interaction,
      async () => {
        await deps.api.sendMessage(existing.thread_id, { content: changes.join("\n") });
      },
      "갱신은 됐어요. 다만 스레드 알림 전송에는 실패했어요."
    )
  );
  return deferredEphemeral();
};
