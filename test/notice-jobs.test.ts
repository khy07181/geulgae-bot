import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { fallbackNotice } from "../src/jobs/fallback-notice";
import { reminder } from "../src/jobs/reminder";
import type { JobDeps } from "../src/jobs/settle";
import { CHANNEL_ID, DEFAULT_NOW, fakeApi, makeEnv, type ApiCall } from "./helpers";

const NOW_ISO = DEFAULT_NOW.toISOString();

function jobDeps(): JobDeps & { calls: ApiCall[] } {
  const fake = fakeApi();
  return { env: makeEnv(), db: env.DB, api: fake.api, now: () => DEFAULT_NOW, calls: fake.calls };
}

describe("fallbackNotice (화요일 안전망)", () => {
  it("이번 주 사이클이 없으면 버튼 공지 → 스레드 → 사이클 생성 → 스레드 안내", async () => {
    const deps = jobDeps();
    await fallbackNotice(deps);

    expect(deps.calls.map((c) => c.method)).toEqual(["sendMessage", "createThread", "sendMessage"]);
    expect(deps.calls[0].args[0]).toBe(CHANNEL_ID);
    expect(JSON.stringify(deps.calls[0].args[1])).toContain('"custom_id":"join:2026-07-20"');

    const cycle = await q.getCycleByWeekStart(env.DB, "2026-07-20");
    expect(cycle).toMatchObject({ goal_count: 1, penalty_per_post: 10000, created_by: "bot:fallback" });
    expect(cycle?.thread_id).toMatch(/^thread-/);
    expect(deps.calls[2].args[0]).toBe(cycle!.thread_id);
  });

  it("이번 주 사이클이 이미 있으면 아무것도 하지 않는다", async () => {
    await q.createCycle(env.DB, {
      weekStart: "2026-07-20", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-A", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    const deps = jobDeps();
    await fallbackNotice(deps);
    expect(deps.calls).toHaveLength(0);
  });
});

describe("reminder (일요일 마감 리마인더)", () => {
  async function seedWithParticipants() {
    const c = await q.createCycle(env.DB, {
      weekStart: "2026-07-20", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-A", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO);
    return c;
  }

  it("미달성 참여자만 멘션한다", async () => {
    const c = await seedWithParticipants();
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u2", url: "https://a.com/p", submittedAt: NOW_ISO });
    const deps = jobDeps();
    await reminder(deps);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].args[0]).toBe("thread-A");
    const content = JSON.stringify(deps.calls[0].args[1]);
    expect(content).toContain("<@u1>");
    expect(content).not.toContain("<@u2>");
  });

  it("전원 달성이면 침묵", async () => {
    const c = await seedWithParticipants();
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u1", url: "https://a.com/1", submittedAt: NOW_ISO });
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u2", url: "https://a.com/2", submittedAt: NOW_ISO });
    const deps = jobDeps();
    await reminder(deps);
    expect(deps.calls).toHaveLength(0);
  });

  it("사이클이 없으면 침묵", async () => {
    const deps = jobDeps();
    await reminder(deps);
    expect(deps.calls).toHaveLength(0);
  });
});
