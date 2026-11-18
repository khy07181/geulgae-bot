import { insertKeywords, listSubmissionsMissingKeywords } from "../db/queries";
import type { Fetcher } from "../discord/api";
import { extractKeywords, htmlToText } from "../domain/keywords";
import { BROWSER_HEADERS } from "../interactions/submit";
import type { AiBinding, Env } from "../types";

// 임시값: 호출 1번에 처리할 제출 수. 건당 fetch+AI 2회라 무료 플랜 서브리퀘스트 한도(50) 안에 둔다.
export const BACKFILL_BATCH_SIZE = 8;

export interface BackfillDeps {
  fetcher: Fetcher;
  ai?: AiBinding;
  now: () => Date;
}

// PAGE-013: 기존 제출의 키워드 소급 일회성 배치.
// POST /s/<PAGE_TOKEN>/keywords-backfill?after=<id> — done이 될 때까지 after=lastId로 반복 호출.
// 응답은 집계만 담는다(글 내용·개인 데이터 없음). 실패·빈 결과는 건너뛰고 커서로 지나간다.
export async function handleKeywordBackfill(
  request: Request,
  env: Env,
  deps: BackfillDeps
): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/s\/([^/]+)\/keywords-backfill$/);
  if (!m || !env.PAGE_TOKEN || m[1] !== env.PAGE_TOKEN) return new Response("Not Found", { status: 404 });
  if (!deps.ai) return Response.json({ error: "AI 바인딩이 없어요" }, { status: 503 });

  const after = Number(url.searchParams.get("after") ?? "0") || 0;
  const batch = await listSubmissionsMissingKeywords(env.DB, after, BACKFILL_BATCH_SIZE);
  let extracted = 0;
  let skipped = 0;
  for (const s of batch) {
    try {
      const res = await deps.fetcher(s.url, {
        signal: AbortSignal.timeout(5000),
        redirect: "follow",
        headers: BROWSER_HEADERS,
      });
      if (!res.ok) {
        skipped += 1;
        continue;
      }
      const keywords = await extractKeywords(deps.ai, s.fetch_title, htmlToText(await res.text()));
      if (keywords.length === 0) {
        skipped += 1;
        continue;
      }
      await insertKeywords(env.DB, s.id, keywords, deps.now().toISOString());
      extracted += 1;
    } catch {
      skipped += 1; // 접근 불가(삭제·비공개)·추출 실패는 건너뛴다 (PAGE-013)
    }
  }
  const lastId = batch.length > 0 ? batch[batch.length - 1].id : after;
  return Response.json({
    processed: batch.length,
    extracted,
    skipped,
    lastId,
    done: batch.length < BACKFILL_BATCH_SIZE,
  });
}
