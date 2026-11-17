import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import * as q from "../src/db/queries";
import { makeEnv } from "./helpers";

const U1 = "111222333444555666"; // 닉네임 등록자
const U2 = "999888777666555444"; // 미등록자 → 익명 라벨

async function get(path: string, envOverrides = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://bot.test${path}`) as unknown as Request<unknown, IncomingRequestCfProperties>,
    makeEnv(envOverrides),
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedLibrary() {
  const c = await q.createCycle(env.DB, {
    weekStart: "2026-07-13", goalCount: 1, penaltyPerPost: 10000,
    channelId: "chan-1", threadId: "t-1", createdBy: `user:${U1}`, createdAt: "2026-07-13T00:00:00Z",
  });
  await q.addParticipant(env.DB, c.id, U1, "manual", "2026-07-13T01:00:00Z");
  await q.addParticipant(env.DB, c.id, U2, "manual", "2026-07-13T01:00:00Z");
  const s1 = await q.insertSubmission(env.DB, { cycleId: c.id, userId: U1, url: "https://blog.test/post-1", submittedAt: "2026-07-14T00:00:00Z" });
  if (s1 !== "duplicate") await q.setSubmissionFetchResult(env.DB, s1.id, "ok", "첫 번째 글");
  await q.insertSubmission(env.DB, { cycleId: c.id, userId: U2, url: "https://blog.test/post-2", submittedAt: "2026-07-15T00:00:00Z" });
  await q.setNickname(env.DB, U1, "하영", "2026-07-13T02:00:00Z");
  return c;
}

describe("서재 페이지 (GET)", () => {
  it("루트는 기존 무해 응답을 유지한다 (PAGE-001)", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("geulgae-bot");
  });

  it("틀린 토큰은 404 (PAGE-004)", async () => {
    await seedLibrary();
    expect((await get("/s/wrong-token")).status).toBe(404);
    expect((await get("/s/wrong-token/")).status).toBe(404);
    expect((await get("/anything")).status).toBe(404);
  });

  it("PAGE_TOKEN 미설정이면 서재 경로는 닫힌다 (PAGE-003)", async () => {
    await seedLibrary();
    expect((await get("/s/test-page-token", { PAGE_TOKEN: undefined })).status).toBe(404);
  });

  it("맞는 토큰이면 통계·글 목록·닉네임을 렌더한다", async () => {
    await seedLibrary();
    const res = await get("/s/test-page-token");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("글개 서재");
    expect(html).toContain("글 2편 · 1주차 · 참여 2명");
    expect(html).toContain("첫 번째 글"); // fetch_title 사용
    expect(html).toContain("https://blog.test/post-2"); // 제목 없으면 URL 표시
    expect(html).toContain("하영"); // 닉네임
    expect(html).toContain("익명 A"); // 미등록자 라벨
    expect(html).toContain("7월 2주차");
    expect(html).toContain("noindex"); // 검색엔진 수집 금지
  });

  it("Discord 숫자 ID는 페이지에 노출되지 않는다 (PAGE-001)", async () => {
    await seedLibrary();
    const html = await (await get("/s/test-page-token")).text();
    expect(html).not.toContain(U1);
    expect(html).not.toContain(U2);
  });

  it("닉네임·제목의 HTML은 이스케이프된다", async () => {
    const c = await seedLibrary();
    await q.setNickname(env.DB, U1, '<b>해커"', "2026-07-13T03:00:00Z");
    const sub = await q.insertSubmission(env.DB, { cycleId: c.id, userId: U1, url: "https://blog.test/post-3", submittedAt: "2026-07-16T00:00:00Z" });
    if (sub !== "duplicate") await q.setSubmissionFetchResult(env.DB, sub.id, "ok", "<script>x</script>");
    const html = await (await get("/s/test-page-token")).text();
    expect(html).not.toContain("<b>해커");
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;b&gt;해커&quot;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("인증 글이 없는 주차도 표시된다", async () => {
    await q.createCycle(env.DB, {
      weekStart: "2026-07-20", goalCount: 2, penaltyPerPost: 10000,
      channelId: "chan-1", threadId: "t-2", createdBy: "bot:fallback", createdAt: "2026-07-20T00:00:00Z",
    });
    const html = await (await get("/s/test-page-token")).text();
    expect(html).toContain("인증 글 없음");
  });
});
