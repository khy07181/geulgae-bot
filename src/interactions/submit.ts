import {
  addParticipant, countSubmissionsByUser, insertSubmission, setSubmissionFetchResult, type CycleRow,
} from "../db/queries";
import { isPastDeadline } from "../domain/cycle";
import { normalizeUrl } from "../domain/url";
import { ephemeral, publicMessage } from "../discord/replies";
import type { Deps, Handler } from "../router";
import { getStringOption, interactionUserId } from "../types";
import { resolveCycle } from "./resolve-cycle";

export const handleSubmit: Handler = async (interaction, deps) => {
  const raw = getStringOption(interaction, "링크");
  if (!raw) return ephemeral("링크를 입력해주세요.");
  const norm = normalizeUrl(raw);
  if (!norm.ok) return ephemeral(norm.reason);

  const now = deps.now();
  const cycle = await resolveCycle(deps.db, interaction, now);
  if (!cycle) return ephemeral("이번 주 목표가 아직 없어요. `/목표설정`을 먼저 해주세요.");
  if (isPastDeadline(cycle.week_start, now)) return ephemeral("이미 마감된 주차예요.");

  const userId = interactionUserId(interaction);
  const nowIso = now.toISOString();
  const newlyJoined = await addParticipant(deps.db, cycle.id, userId, "submit", nowIso);
  const inserted = await insertSubmission(deps.db, {
    cycleId: cycle.id, userId, url: norm.url, submittedAt: nowIso,
  });
  if (inserted === "duplicate") return ephemeral("이미 인증한 링크예요.");

  const count = (await countSubmissionsByUser(deps.db, cycle.id)).get(userId) ?? 0;
  deps.ctx.waitUntil(verifyAndReport(deps, cycle, inserted.id, norm.url));

  const joinedNote = newlyJoined ? " (참여자로 자동 등록했어요)" : "";
  return publicMessage(
    `<@${userId}>님 인증 완료! 현재 ${count}/${cycle.goal_count}개${joinedNote}\n${norm.url}`
  );
};

// 스펙 §5.3-7: best-effort 검증. 실패해도 인증에 영향 없음.
async function verifyAndReport(
  deps: Deps,
  cycle: CycleRow,
  submissionId: number,
  url: string
): Promise<void> {
  let status: "ok" | "failed" = "failed";
  let title: string | null = null;
  try {
    const res = await deps.fetcher(url, { signal: AbortSignal.timeout(5000), redirect: "follow" });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      title = m ? m[1].trim().slice(0, 100) || null : null;
      status = "ok";
    }
  } catch {
    // 타임아웃·네트워크 오류 → failed 기록만
  }
  await setSubmissionFetchResult(deps.db, submissionId, status, title);
  const note =
    status === "ok"
      ? `🔗 ${title ?? "(제목 없음)"}`
      : "⚠️ 링크 접속 확인은 실패했지만 인증은 유효해요.";
  await deps.api.sendMessage(cycle.thread_id, { content: note, allowed_mentions: { parse: [] } });
}
