import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import * as q from "../src/db/queries";
import { recapYearOf } from "../src/domain/cycle";
import { buildRecap } from "../src/domain/recap";
import { makeEnv } from "./helpers";

describe("recapYearOf (PAGE-005)", () => {
  it("해 안에 온전히 든 주는 그 해", () => {
    expect(recapYearOf("2026-07-20")).toBe(2026);
  });
  it("해를 걸치는 주는 마감일(일요일)의 연도", () => {
    expect(recapYearOf("2026-12-28")).toBe(2027); // 일요일이 2027-01-03
    expect(recapYearOf("2025-12-29")).toBe(2026); // 일요일이 2026-01-04
  });
  it("일요일이 12-31이면 그 해", () => {
    expect(recapYearOf("2028-12-25")).toBe(2028); // 일요일이 2028-12-31
  });
});

describe("buildRecap", () => {
  const cycle = (id: number, weekStart: string, goal = 1): q.CycleRow => ({
    id, week_start: weekStart, goal_count: goal, penalty_per_post: 10000,
    channel_id: "c", thread_id: `t${id}`, created_by: "user:x", created_at: "2026-01-01T00:00:00Z", settled_at: null,
  });
  const sub = (id: number, cycleId: number, userId: string, submittedAt: string, title: string | null = null): q.SubmissionRow => ({
    id, cycle_id: cycleId, user_id: userId, url: `https://a/${id}`, fetch_title: title, submitted_at: submittedAt,
  });

  it("사람별 글·달성·참여와 전원 달성 주, 벌금 합계를 집계한다", () => {
    const r = buildRecap({
      year: 2026,
      cycles: [cycle(1, "2026-07-13"), cycle(2, "2026-07-20", 2), cycle(9, "2025-07-14")],
      submissions: [
        sub(11, 1, "u1", "2026-07-14T00:00:00Z"),
        sub(12, 1, "u2", "2026-07-14T01:00:00Z"),
        sub(13, 2, "u1", "2026-07-21T00:00:00Z", "두 번째 주"),
        sub(19, 9, "u1", "2025-07-15T00:00:00Z"), // 다른 해
      ],
      participants: [
        { cycle_id: 1, user_id: "u1" }, { cycle_id: 1, user_id: "u2" },
        { cycle_id: 2, user_id: "u1" },
      ],
      penalties: [
        { user_id: "u1", amount: 10000, kind: "settlement", cycle_id: 2, created_at: "2026-07-27T00:00:00Z" },
        { user_id: "u1", amount: 20000, kind: "settlement", cycle_id: 9, created_at: "2025-07-21T00:00:00Z" }, // 다른 해 사이클
        { user_id: "u2", amount: -5000, kind: "adjustment", cycle_id: null, created_at: "2026-08-01T00:00:00Z" },
        { user_id: "u2", amount: 7000, kind: "adjustment", cycle_id: null, created_at: "2025-08-01T00:00:00Z" }, // 다른 해 조정
      ],
      keywords: [
        { submission_id: 11, keyword: "회고" },
        { submission_id: 11, keyword: "러닝" },
        { submission_id: 13, keyword: "회고" },
        { submission_id: 19, keyword: "옛글" }, // 다른 해 제출 → 제외
      ],
    });
    expect(r.weekCount).toBe(2);
    expect(r.postCount).toBe(3);
    expect(r.allAchievedWeekLabels).toEqual(["2026-07-13"]); // 2번 주는 u1이 2개 목표에 1개
    expect(r.members).toEqual([
      { userId: "u1", posts: 2, achievedWeeks: 1, joinedWeeks: 2, longestStreak: 1 },
      { userId: "u2", posts: 1, achievedWeeks: 1, joinedWeeks: 1, longestStreak: 1 },
    ]);
    expect(r.settlementSum).toBe(10000);
    expect(r.adjustmentSum).toBe(-5000);
    // 월별: 7월(KST)에 3편
    expect(r.monthlyPosts[6]).toBe(3);
    expect(r.monthlyPosts.reduce((a, b) => a + b, 0)).toBe(3);
    // 키워드: 연도 내 제출만, 빈도 내림차순
    expect(r.keywords).toEqual([{ keyword: "회고", count: 2 }, { keyword: "러닝", count: 1 }]);
    // 올해의 기록
    expect(r.records?.firstPost).toEqual({ title: "https://a/11", userId: "u1", dateLabel: "7월 14일" });
    expect(r.records?.lastPost).toEqual({ title: "두 번째 주", userId: "u1", dateLabel: "7월 21일" });
    expect(r.records?.busiestMonth).toEqual({ month: 7, count: 3 });
    expect(r.records?.longestAllAchievedRun).toEqual({ length: 1, startLabel: "7월 2주차", endLabel: "7월 2주차" });
  });

  it("스트릭과 전원 달성 연속은 주 순서의 연속만 센다 (PAGE-009)", () => {
    const r = buildRecap({
      year: 2026,
      cycles: [cycle(1, "2026-07-06"), cycle(2, "2026-07-13"), cycle(3, "2026-07-20"), cycle(4, "2026-07-27")],
      submissions: [
        sub(1, 1, "u1", "2026-07-07T00:00:00Z"),
        sub(2, 2, "u1", "2026-07-14T00:00:00Z"),
        sub(3, 4, "u1", "2026-07-28T00:00:00Z"),
      ],
      participants: [
        { cycle_id: 1, user_id: "u1" }, { cycle_id: 2, user_id: "u1" },
        { cycle_id: 3, user_id: "u1" }, // 참여했지만 미제출 → 연속 끊김
        { cycle_id: 4, user_id: "u1" },
      ],
      penalties: [],
    });
    expect(r.members[0].longestStreak).toBe(2); // 1·2주 연속, 3주에서 끊김
    expect(r.records?.longestAllAchievedRun).toEqual({ length: 2, startLabel: "7월 1주차", endLabel: "7월 2주차" });
  });

  it("조정의 연도는 created_at의 KST 기준이다", () => {
    const r = buildRecap({
      year: 2027, cycles: [], submissions: [], participants: [],
      // UTC로는 2026-12-31 15:30 = KST 2027-01-01 00:30
      penalties: [{ user_id: "u1", amount: 3000, kind: "adjustment", cycle_id: null, created_at: "2026-12-31T15:30:00Z" }],
    });
    expect(r.adjustmentSum).toBe(3000);
  });
});

describe("결산 페이지 (GET)", () => {
  async function get(path: string) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://bot.test${path}`) as unknown as Request<unknown, IncomingRequestCfProperties>,
      makeEnv(),
      ctx
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("연도 결산을 렌더하고 아카이브로 돌아가는 링크를 둔다", async () => {
    const c = await q.createCycle(env.DB, {
      weekStart: "2026-07-13", goalCount: 1, penaltyPerPost: 10000,
      channelId: "chan-1", threadId: "t-1", createdBy: "user:u1", createdAt: "2026-07-13T00:00:00Z",
    });
    await q.addParticipant(env.DB, c.id, "111222333444555666", "manual", "2026-07-13T01:00:00Z");
    const s = await q.insertSubmission(env.DB, { cycleId: c.id, userId: "111222333444555666", url: "https://a/1", submittedAt: "2026-07-14T00:00:00Z" });
    if (s !== "duplicate") await q.insertKeywords(env.DB, s.id, ["타입스크립트", "회고"], "2026-07-14T00:00:00Z");
    await q.setNickname(env.DB, "111222333444555666", "하영", "2026-07-13T02:00:00Z");

    const res = await get("/s/test-page-token/2026");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("2026 글개 결산");
    expect(html).toContain("올해의 글"); // 스탯 타일
    expect(html).toContain("누가 썼나");
    expect(html).toContain("한 해의 리듬");
    expect(html).toContain("올해의 키워드");
    expect(html).toContain("타입스크립트");
    expect(html).toContain("올해의 기록");
    expect(html).toContain("하영");
    expect(html).not.toContain("111222333444555666"); // PAGE-001
    expect(html).toContain('href="./"'); // 아카이브로
  });

  it("기록이 없는 해는 빈 결산 안내", async () => {
    const html = await (await get("/s/test-page-token/1999")).text();
    expect(html).toContain("기록이 없어요");
  });

  it("경로 정규화: 아카이브는 슬래시 붙이고 결산은 뗀다", async () => {
    const r1 = await get("/s/test-page-token");
    expect(r1.status).toBe(308);
    expect(r1.headers.get("location")).toBe("https://bot.test/s/test-page-token/");
    const r2 = await get("/s/test-page-token/2026/");
    expect(r2.status).toBe(308);
    expect(r2.headers.get("location")).toBe("https://bot.test/s/test-page-token/2026");
  });

  it("틀린 토큰은 결산 경로도 404", async () => {
    expect((await get("/s/wrong/2026")).status).toBe(404);
  });
});
