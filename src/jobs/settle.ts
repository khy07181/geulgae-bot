import {
  countSubmissionsByUser, insertSettlementEntries, listParticipants, listUnsettledCycles, markSettled,
} from "../db/queries";
import type { DiscordApi } from "../discord/api";
import { isPastDeadline, weekLabel } from "../domain/cycle";
import { calculateSettlement } from "../domain/settlement";
import type { Env } from "../types";

export interface JobDeps {
  env: Env;
  db: D1Database;
  api: DiscordApi;
  now: () => Date;
}

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export async function settleSweep(deps: JobDeps): Promise<void> {
  const now = deps.now();
  const targets = (await listUnsettledCycles(deps.db)).filter((c) => isPastDeadline(c.week_start, now));

  for (const cycle of targets) {
    try {
      const participants = await listParticipants(deps.db, cycle.id);
      const counts = await countSubmissionsByUser(deps.db, cycle.id);
      const charges = calculateSettlement({
        goalCount: cycle.goal_count,
        penaltyPerPost: cycle.penalty_per_post,
        participants: participants.map((p) => ({
          userId: p.user_id,
          submissionCount: counts.get(p.user_id) ?? 0,
        })),
      });
      const label = weekLabel(cycle.week_start);

      // 1) 원장 기록 (INSERT OR IGNORE — 재실행에도 멱등)
      await insertSettlementEntries(
        deps.db,
        cycle.id,
        charges.map((c) => ({
          userId: c.userId,
          amount: c.amount,
          reason: `${label} 정산 (${c.shortfall}개 미달)`,
        })),
        now.toISOString()
      );

      // 2) 공지 (실패하면 throw → settled_at을 찍지 않고 다음 실행이 재시도)
      if (participants.length > 0) {
        const content =
          charges.length === 0
            ? `🎉 **${label} 전원 목표 달성!** 벌금 없이 마감됐어요.`
            : `⚖️ **${label} 정산 결과**\n` +
              charges
                .map((c) => `- <@${c.userId}>님: ${c.shortfall}개 미달 → 벌금 ${won(c.amount)}`)
                .join("\n");
        await deps.api.sendMessage(cycle.thread_id, { content });
      }

      // 3) 정산 완료 표시
      await markSettled(deps.db, cycle.id, now.toISOString());
    } catch (err) {
      // 한 사이클의 실패가 다른 사이클 정산을 막지 않는다.
      // settled_at이 찍히지 않았으므로 다음 sweep이 이 사이클을 재시도한다.
      console.error(`정산 실패 (cycle ${cycle.id}, ${cycle.week_start}):`, err);
    }
  }
}
