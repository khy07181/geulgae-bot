import { createCycle, getCycleByWeekStart } from "../db/queries";
import { weekLabel, weekStartOf } from "../domain/cycle";
import type { JobDeps } from "./settle";

// 화 10:00 KST — 이번 주 목표가 없으면 기본값으로 생성하고 참여 버튼 공지 (스펙 §6)
export async function fallbackNotice(deps: JobDeps): Promise<void> {
  const now = deps.now();
  const weekStart = weekStartOf(now);
  if (await getCycleByWeekStart(deps.db, weekStart)) return;

  const label = weekLabel(weekStart);
  const msg = await deps.api.sendMessage(deps.env.CHANNEL_ID, {
    content:
      `📣 아직 **${label} 목표**가 없어요! 아래 버튼으로 참여하거나 \`/목표설정\`으로 직접 설정해주세요.\n` +
      `기본 설정: 주당 1개 · 미달 1개당 10,000원 · 일요일 23:59 마감`,
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 1, label: "참여하기", custom_id: `join:${weekStart}` }],
      },
    ],
  });
  const thread = await deps.api.createThread(deps.env.CHANNEL_ID, msg.id, `${label} 글쓰기`);
  await createCycle(deps.db, {
    weekStart,
    goalCount: 1,
    penaltyPerPost: 10000,
    channelId: deps.env.CHANNEL_ID,
    threadId: thread.id,
    createdBy: "bot:fallback",
    createdAt: now.toISOString(),
  });
  await deps.api.sendMessage(thread.id, {
    content: `${label} 스레드예요. 참여자는 여기서 \`/인증\`으로 글을 인증해주세요.`,
  });
}
