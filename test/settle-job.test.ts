import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import type { DiscordApi } from "../src/discord/api";
import { settleSweep, type JobDeps } from "../src/jobs/settle";
import { CHANNEL_ID, DEFAULT_NOW, fakeApi, makeEnv, type ApiCall } from "./helpers";

const NOW_ISO = "2026-07-15T03:00:00.000Z"; // 지난주 수요일

function jobDeps(api?: DiscordApi): JobDeps & { calls: ApiCall[] } {
  const fake = fakeApi();
  return {
    env: makeEnv(),
    db: env.DB,
    api: api ?? fake.api,
    now: () => DEFAULT_NOW, // 2026-07-22 수요일 → 2026-07-13 주는 마감 지남
    calls: fake.calls,
  };
}

async function seedLastWeek(goalCount = 1) {
  const c = await q.createCycle(env.DB, {
    weekStart: "2026-07-13", goalCount, penaltyPerPost: 10000,
    channelId: CHANNEL_ID, threadId: "thread-OLD", createdBy: "user:u1", createdAt: NOW_ISO,
  });
  return c;
}

describe("settleSweep", () => {
  it("마감 지난 미정산 사이클: 미달자에게 부과, 공지, settled 처리", async () => {
    const c = await seedLastWeek();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO); // 0개 → 미달
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO); // 1개 → 달성
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u2", url: "https://a.com/p", submittedAt: NOW_ISO });

    const deps = jobDeps();
    await settleSweep(deps);

    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000);
    expect(await q.getPenaltyBalance(env.DB, "u2")).toBe(0);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).not.toBeNull();
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].args[0]).toBe("thread-OLD");
    expect(JSON.stringify(deps.calls[0].args[1])).toContain("<@u1>");
  });

  it("두 번 실행해도 벌금·공지가 중복되지 않는다 (멱등)", async () => {
    const c = await seedLastWeek();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const deps = jobDeps();
    await settleSweep(deps);
    await settleSweep(deps); // settled_at이 찍혀 있어 두 번째는 no-op
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000);
    expect(deps.calls).toHaveLength(1);
  });

  it("전원 달성이면 축하 공지만", async () => {
    const c = await seedLastWeek();
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO);
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u2", url: "https://a.com/p", submittedAt: NOW_ISO });
    const deps = jobDeps();
    await settleSweep(deps);
    expect(JSON.stringify(deps.calls[0].args[1])).toContain("전원");
    expect(await q.getPenaltyBalance(env.DB, "u2")).toBe(0);
  });

  it("참여자 0명이면 공지 없이 settled 처리", async () => {
    await seedLastWeek();
    const deps = jobDeps();
    await settleSweep(deps);
    expect(deps.calls).toHaveLength(0);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).not.toBeNull();
  });

  it("마감 전 사이클은 건드리지 않는다", async () => {
    const c = await q.createCycle(env.DB, {
      weekStart: "2026-07-20", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-A", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const deps = jobDeps();
    await settleSweep(deps);
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(0);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-20"))?.settled_at).toBeNull();
  });

  it("공지 실패 시 settled_at을 찍지 않는다 (다음 실행이 재시도, 원장은 멱등)", async () => {
    const c = await seedLastWeek();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const throwingApi = {
      sendMessage: async () => { throw new Error("Discord 500"); },
      createThread: async () => { throw new Error("unused"); },
    } as unknown as DiscordApi;
    await expect(settleSweep(jobDeps(throwingApi))).rejects.toThrow("Discord 500");
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000); // 원장은 이미 기록
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).toBeNull();

    // 다음 실행(정상 API)이 마무리한다 — 벌금 중복 없이 공지 + settled
    const deps = jobDeps();
    await settleSweep(deps);
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000);
    expect(deps.calls).toHaveLength(1);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).not.toBeNull();
  });
});
