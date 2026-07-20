import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
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
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await settleSweep(jobDeps(throwingApi)); // 실패는 사이클 단위로 격리되어 sweep 자체는 완료된다
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000); // 원장은 이미 기록
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).toBeNull();

    // 다음 실행(정상 API)이 마무리한다 — 벌금 중복 없이 공지 + settled
    const deps = jobDeps();
    await settleSweep(deps);
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000);
    expect(deps.calls).toHaveLength(1);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).not.toBeNull();
  });

  it("한 사이클의 공지 실패가 다른 사이클 정산을 막지 않는다", async () => {
    const c1 = await q.createCycle(env.DB, {
      weekStart: "2026-07-06", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-OLD1", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    const c2 = await q.createCycle(env.DB, {
      weekStart: "2026-07-13", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-OLD2", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    await q.addParticipant(env.DB, c1.id, "u1", "manual", NOW_ISO);
    await q.addParticipant(env.DB, c2.id, "u2", "manual", NOW_ISO);

    const sent: string[] = [];
    const api = {
      async sendMessage(channelId: string) {
        if (channelId === "thread-OLD1") throw new Error("Discord 500");
        sent.push(channelId);
        return { id: "1" };
      },
      async createThread() {
        throw new Error("unused");
      },
    } as unknown as DiscordApi;

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await settleSweep({ env: makeEnv(), db: env.DB, api, now: () => DEFAULT_NOW });
    errSpy.mockRestore();

    // c1: 원장은 기록됐지만 미정산으로 남아 다음 sweep이 재시도
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(10000);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-06"))?.settled_at).toBeNull();
    // c2: 정상 정산 완료
    expect(await q.getPenaltyBalance(env.DB, "u2")).toBe(10000);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-13"))?.settled_at).not.toBeNull();
    expect(sent).toEqual(["thread-OLD2"]);
  });
});
