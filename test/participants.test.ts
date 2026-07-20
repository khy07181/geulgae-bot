import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handleJoinButton } from "../src/interactions/join-button";
import { handleWithdraw } from "../src/interactions/withdraw";
import {
  CHANNEL_ID, DEFAULT_NOW, makeCommandInteraction, makeComponentInteraction, makeDeps, readJson,
} from "./helpers";

const NOW_ISO = DEFAULT_NOW.toISOString();

async function seedCycle(weekStart = "2026-07-20", threadId = "thread-A") {
  return q.createCycle(env.DB, {
    weekStart, goalCount: 1, penaltyPerPost: 10000,
    channelId: CHANNEL_ID, threadId, createdBy: "user:u1", createdAt: NOW_ISO,
  });
}

describe("/참여취소", () => {
  it("대상 옵션이 없으면 본인을 취소한다", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const body = await readJson(await handleWithdraw(makeCommandInteraction("참여취소"), makeDeps()));
    expect(body.data.content).toContain("<@u1>");
    expect(await q.listParticipants(env.DB, c.id)).toEqual([]);
  });
  it("누구나 대상을 지정해 취소할 수 있다", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO);
    const i = makeCommandInteraction("참여취소", [{ name: "대상", type: 6, value: "u2" }]);
    await handleWithdraw(i, makeDeps());
    expect(await q.listParticipants(env.DB, c.id)).toEqual([]);
  });
  it("이미 인증한 글이 있으면 거부", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    await q.insertSubmission(env.DB, { cycleId: c.id, userId: "u1", url: "https://a.com/p", submittedAt: NOW_ISO });
    const body = await readJson(await handleWithdraw(makeCommandInteraction("참여취소"), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect((await q.listParticipants(env.DB, c.id)).length).toBe(1);
  });
  it("참여자가 아니면 ephemeral", async () => {
    await seedCycle();
    const body = await readJson(await handleWithdraw(makeCommandInteraction("참여취소"), makeDeps()));
    expect(body.data.flags).toBe(64);
  });
  it("마감 후에는 거부", async () => {
    await seedCycle("2026-07-13", "thread-OLD");
    const i = makeCommandInteraction("참여취소", [], { channelId: "thread-OLD", parentId: CHANNEL_ID });
    const body = await readJson(await handleWithdraw(i, makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("마감");
  });
});

describe("[참여하기] 버튼", () => {
  it("클릭하면 참여자로 등록되고 공개 응답", async () => {
    const c = await seedCycle();
    const body = await readJson(
      await handleJoinButton(makeComponentInteraction("join:2026-07-20", { userId: "u5" }), makeDeps())
    );
    expect(body.data.flags).toBeUndefined();
    expect(body.data.content).toContain("<@u5>");
    expect((await q.listParticipants(env.DB, c.id)).map((p) => p.joined_via)).toEqual(["button"]);
  });
  it("중복 클릭은 ephemeral '이미 참여 중'", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u5", "button", NOW_ISO);
    const body = await readJson(
      await handleJoinButton(makeComponentInteraction("join:2026-07-20", { userId: "u5" }), makeDeps())
    );
    expect(body.data.flags).toBe(64);
  });
  it("마감 지난 주차의 버튼은 거부", async () => {
    await seedCycle("2026-07-13", "thread-OLD");
    const body = await readJson(
      await handleJoinButton(makeComponentInteraction("join:2026-07-13"), makeDeps())
    );
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("마감");
  });
  it("사이클이 없는 week_start면 에러 안내", async () => {
    const body = await readJson(
      await handleJoinButton(makeComponentInteraction("join:2026-07-20"), makeDeps())
    );
    expect(body.data.flags).toBe(64);
  });
});
