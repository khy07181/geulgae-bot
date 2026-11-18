import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import * as q from "../src/db/queries";
import { BACKFILL_BATCH_SIZE, handleKeywordBackfill } from "../src/page/backfill";
import type { Fetcher } from "../src/discord/api";
import type { AiBinding } from "../src/types";
import { CHANNEL_ID, DEFAULT_NOW, makeEnv, readJson } from "./helpers";

const NOW_ISO = DEFAULT_NOW.toISOString();

const okAi: AiBinding = { run: async () => ({ response: '["회고"]' }) };
const routeFetcher: Fetcher = async (input) => {
  const url = String(input);
  if (url.includes("dead")) return new Response("gone", { status: 404 });
  return new Response("<html><title>글</title><body>달리기와 글쓰기</body></html>", { status: 200 });
};

function post(path: string): Request {
  return new Request(`https://bot.test${path}`, { method: "POST" });
}

async function seed() {
  const c = await q.createCycle(env.DB, {
    weekStart: "2026-07-20", goalCount: 1, penaltyPerPost: 10000,
    channelId: CHANNEL_ID, threadId: "t-1", createdBy: "user:u1", createdAt: NOW_ISO,
  });
  const ids: number[] = [];
  for (const [user, url] of [["u1", "https://a.com/1"], ["u2", "https://a.com/dead"], ["u3", "https://a.com/3"]] as const) {
    const s = await q.insertSubmission(env.DB, { cycleId: c.id, userId: user, url, submittedAt: NOW_ISO });
    if (s === "duplicate") throw new Error("seed 실패");
    ids.push(s.id);
  }
  await q.insertKeywords(env.DB, ids[2], ["독서"], NOW_ISO); // s3는 이미 키워드 보유
  return ids;
}

describe("키워드 소급 배치 (PAGE-013)", () => {
  it("키워드 없는 제출만 처리하고 집계만 돌려준다", async () => {
    const [id1, id2] = await seed();
    const res = await handleKeywordBackfill(post("/s/test-page-token/keywords-backfill"), makeEnv(), {
      fetcher: routeFetcher, ai: okAi, now: () => DEFAULT_NOW,
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    // s3(이미 보유)는 대상 제외, s1 성공, s2(404)는 건너뜀
    expect(body).toEqual({ processed: 2, extracted: 1, skipped: 1, lastId: id2, done: true });
    const rows = await q.listAllKeywords(env.DB);
    expect(rows).toContainEqual({ submission_id: id1, keyword: "회고" });
    expect(rows).toHaveLength(2); // s1 회고 + s3 독서
    expect(JSON.stringify(body)).not.toContain("a.com"); // 집계만, URL·내용 없음
  });

  it("after 커서 뒤부터 처리한다", async () => {
    const [id1, id2] = await seed();
    const res = await handleKeywordBackfill(
      post(`/s/test-page-token/keywords-backfill?after=${id1}`),
      makeEnv(),
      { fetcher: routeFetcher, ai: okAi, now: () => DEFAULT_NOW }
    );
    const body = await readJson(res);
    expect(body.processed).toBe(1); // id2만
    expect(body.lastId).toBe(id2);
  });

  it("틀린 토큰·토큰 미설정은 404", async () => {
    await seed();
    const deps = { fetcher: routeFetcher, ai: okAi, now: () => DEFAULT_NOW };
    expect((await handleKeywordBackfill(post("/s/wrong/keywords-backfill"), makeEnv(), deps)).status).toBe(404);
    expect(
      (await handleKeywordBackfill(post("/s/test-page-token/keywords-backfill"), makeEnv({ PAGE_TOKEN: undefined }), deps)).status
    ).toBe(404);
  });

  it("AI 바인딩이 없으면 503", async () => {
    const res = await handleKeywordBackfill(post("/s/test-page-token/keywords-backfill"), makeEnv(), {
      fetcher: routeFetcher, now: () => DEFAULT_NOW,
    });
    expect(res.status).toBe(503);
  });

  it("배치 크기만큼 끊어 처리하고 done으로 알린다", async () => {
    const c = await q.createCycle(env.DB, {
      weekStart: "2026-07-20", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "t-1", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    for (let i = 0; i < BACKFILL_BATCH_SIZE + 2; i++) {
      await q.insertSubmission(env.DB, { cycleId: c.id, userId: `u${i}`, url: `https://a.com/p${i}`, submittedAt: NOW_ISO });
    }
    const deps = { fetcher: routeFetcher, ai: okAi, now: () => DEFAULT_NOW };
    const first = await readJson(await handleKeywordBackfill(post("/s/test-page-token/keywords-backfill"), makeEnv(), deps));
    expect(first.processed).toBe(BACKFILL_BATCH_SIZE);
    expect(first.done).toBe(false);
    const second = await readJson(
      await handleKeywordBackfill(post(`/s/test-page-token/keywords-backfill?after=${first.lastId}`), makeEnv(), deps)
    );
    expect(second.processed).toBe(2);
    expect(second.done).toBe(true);
  });

  it("워커 라우팅: /s/ 경로의 POST는 서명 검증 없이 배치로 간다 (틀린 토큰 404)", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      post("/s/wrong/keywords-backfill") as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });
});
