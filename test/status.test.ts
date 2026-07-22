import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handleStatus } from "../src/interactions/status";
import { CHANNEL_ID, DEFAULT_NOW, makeCommandInteraction, makeDeps, readJson } from "./helpers";

const NOW_ISO = DEFAULT_NOW.toISOString();

describe("/현황", () => {
  it("참여자별 N/M와 달성 체크, 멘션 알림은 끈다", async () => {
    const c = await q.createCycle(env.DB, {
      weekStart: "2026-07-20", goalCount: 2, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-A", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO);
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u1", url: "https://a.com/1", submittedAt: NOW_ISO });
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u1", url: "https://a.com/2", submittedAt: NOW_ISO });

    // 채널에서 조회 → 본인만 (공개 기록은 스레드에만)
    const body = await readJson(await handleStatus(makeCommandInteraction("현황"), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("<@u1>: 2/2개 ✅");
    expect(body.data.content).toContain("<@u2>: 0/2개");
    expect(body.data.content).toContain("마감까지");

    // 사이클 스레드 안에서 조회 → 공개 + 멘션 알림 차단
    const inThread = makeCommandInteraction("현황", [], { channelId: "thread-A", parentId: CHANNEL_ID });
    const pub = await readJson(await handleStatus(inThread, makeDeps()));
    expect(pub.data.flags).toBeUndefined();
    expect(pub.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("마감된 주차의 스레드에서도 조회는 된다", async () => {
    await q.createCycle(env.DB, {
      weekStart: "2026-07-13", goalCount: 1, penaltyPerPost: 10000,
      channelId: CHANNEL_ID, threadId: "thread-OLD", createdBy: "user:u1", createdAt: NOW_ISO,
    });
    const i = makeCommandInteraction("현황", [], { channelId: "thread-OLD", parentId: CHANNEL_ID });
    const body = await readJson(await handleStatus(i, makeDeps()));
    expect(body.data.content).toContain("마감됨");
  });

  it("사이클이 없으면 ephemeral", async () => {
    const body = await readJson(await handleStatus(makeCommandInteraction("현황"), makeDeps()));
    expect(body.data.flags).toBe(64);
  });
});
