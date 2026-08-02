import {
  addParticipant, countSubmissionsByUser, insertSubmission, setSubmissionFetchResult, type CycleRow,
} from "../db/queries";
import { isPastDeadline } from "../domain/cycle";
import { normalizeUrl } from "../domain/url";
import { deferredEphemeral, ephemeral } from "../discord/replies";
import type { Deps, Handler } from "../router";
import { getStringOption, interactionUserId } from "../types";
import { resolveCycle } from "./resolve-cycle";
import { settleDeferred } from "./silent";

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
  // 중복 검사가 참여 등록보다 먼저다: 거부되는 제출로 유령 참여자(제출 없이 벌금 대상)가
  // 생기지 않도록, 성공적으로 저장된 제출에 대해서만 참여자로 등록한다.
  const inserted = await insertSubmission(deps.db, {
    cycleId: cycle.id, userId, url: norm.url, submittedAt: nowIso,
  });
  if (inserted === "duplicate") return ephemeral("이미 인증한 링크예요.");
  const newlyJoined = await addParticipant(deps.db, cycle.id, userId, "submit", nowIso);

  const count = (await countSubmissionsByUser(deps.db, cycle.id)).get(userId) ?? 0;
  const joinedNote = newlyJoined ? " (참여자로 자동 등록했어요)" : "";
  // 성공 시 실행자에게는 조용히 처리. 공개 알림(스레드) → 접속 확인 → 제목 후속 순서.
  deps.ctx.waitUntil(
    (async () => {
      await settleDeferred(
        deps,
        interaction,
        async () => {
          await deps.api.sendMessage(cycle.thread_id, {
            content: `📝 <@${userId}>님 인증 완료! 현재 ${count}/${cycle.goal_count}개${joinedNote}\n${norm.url}`,
            allowed_mentions: { parse: [] },
          });
        },
        `인증은 저장됐어요 (현재 ${count}/${cycle.goal_count}개). 다만 스레드 알림 전송에는 실패했어요.`
      );
      await verifyAndReport(deps, cycle, inserted.id, norm.url);
    })()
  );
  return deferredEphemeral();
};

// UA 없는 요청은 Bear Blog(403)·티스토리(500) 등에서 거부되므로 브라우저형 헤더를 보낸다.
const BROWSER_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "ko,en;q=0.9",
};

// 스펙 §5.3-7: best-effort 접속 확인. 실패해도 인증에 영향 없음.
// Medium처럼 헤더로도 못 뚫는 봇 차단(403 챌린지)이 있으므로, 응답이 왔다면
// 404(페이지 없음)만 실패로 보고 나머지는 링크 실존으로 간주한다. 제목은 2xx일 때만 읽는다.
async function verifyAndReport(
  deps: Deps,
  cycle: CycleRow,
  submissionId: number,
  url: string
): Promise<void> {
  let status: "ok" | "failed" = "failed";
  let title: string | null = null;
  let note = "⚠️ 링크 접속 확인은 실패했지만 인증은 유효해요.";
  try {
    const res = await deps.fetcher(url, {
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
      headers: BROWSER_HEADERS,
    });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      title = m ? m[1].trim().slice(0, 100) || null : null;
      status = "ok";
      note = `🔗 ${title ?? "(제목 없음)"}`;
    } else if (res.status === 404) {
      note = "⚠️ 페이지를 찾을 수 없어요(404). 인증은 유효하지만 링크를 한 번 확인해주세요.";
      console.error(`링크 검증 404: ${url}`);
    } else {
      status = "ok";
      note = "🔗 (제목은 못 가져왔어요)";
      console.log(`링크 검증: HTTP ${res.status} → 실존으로 간주: ${url}`);
    }
  } catch (err) {
    console.error(`링크 검증 예외 (${url}):`, err);
  }
  await setSubmissionFetchResult(deps.db, submissionId, status, title);
  try {
    await deps.api.sendMessage(cycle.thread_id, { content: note, allowed_mentions: { parse: [] } });
  } catch (err) {
    console.error("검증 결과 전송 실패:", err);
  }
}
