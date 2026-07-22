import { env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handleJoin } from "../src/interactions/join";
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
  it("대상 옵션이 없으면 본인을 취소하고, 공개 알림은 스레드로만 간다", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const deps = makeDeps();
    const body = await readJson(await handleWithdraw(makeCommandInteraction("참여취소"), deps));
    expect(body.type).toBe(5); // 조용한 처리
    expect(await q.listParticipants(env.DB, c.id)).toEqual([]);

    await waitOnExecutionContext(deps.ctx);
    const sends = deps.calls.filter((c2) => c2.method === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0].args[0]).toBe("thread-A");
    expect(JSON.stringify(sends[0].args[1])).toContain("참여를 취소했어요");
    expect(deps.calls.some((c2) => c2.method === "deleteOriginalResponse")).toBe(true);
  });
  it("누구나 대상을 지정해 취소할 수 있다", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u2", "manual", NOW_ISO);
    const i = makeCommandInteraction("참여취소", [{ name: "대상", type: 6, value: "u2" }]);
    const deps = makeDeps();
    await handleWithdraw(i, deps);
    await waitOnExecutionContext(deps.ctx);
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

describe("/참여", () => {
  it("대상 옵션이 없으면 본인을 등록하고, 공개 알림은 스레드로만 간다", async () => {
    const c = await seedCycle();
    const deps = makeDeps();
    const body = await readJson(await handleJoin(makeCommandInteraction("참여", [], { userId: "u1" }), deps));
    expect(body.type).toBe(5); // 조용한 처리
    expect(await q.listParticipants(env.DB, c.id)).toEqual([{ user_id: "u1", joined_via: "manual" }]);

    await waitOnExecutionContext(deps.ctx);
    const sends = deps.calls.filter((c2) => c2.method === "sendMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0].args[0]).toBe("thread-A");
    expect(JSON.stringify(sends[0].args[1])).toContain("<@u1>");
    expect(JSON.stringify(sends[0].args[1])).toContain("(현재 1명)");
    expect(deps.calls.some((c2) => c2.method === "deleteOriginalResponse")).toBe(true);
  });
  it("누구나 대상을 지정해 등록할 수 있다 (까먹은 사람 대신)", async () => {
    const c = await seedCycle();
    const i = makeCommandInteraction("참여", [{ name: "대상", type: 6, value: "u2" }], { userId: "u1" });
    const deps = makeDeps();
    const body = await readJson(await handleJoin(i, deps));
    expect(body.type).toBe(5);
    await waitOnExecutionContext(deps.ctx);
    expect(await q.listParticipants(env.DB, c.id)).toEqual([{ user_id: "u2", joined_via: "manual" }]);
  });
  it("이미 참여 중이면 ephemeral 거절", async () => {
    const c = await seedCycle();
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const body = await readJson(await handleJoin(makeCommandInteraction("참여", [], { userId: "u1" }), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("이미 참여 중");
  });
  it("마감 지난 주차에서는 거부", async () => {
    await seedCycle("2026-07-13", "thread-OLD");
    const i = makeCommandInteraction("참여", [], { channelId: "thread-OLD", parentId: CHANNEL_ID });
    const body = await readJson(await handleJoin(i, makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("마감");
  });
  it("사이클이 없으면 안내", async () => {
    const body = await readJson(await handleJoin(makeCommandInteraction("참여"), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("/목표설정");
  });
});

describe("[참여하기] 버튼", () => {
  it("클릭하면 참여자로 등록되고, 본인에게는 무응답·참여 공지는 스레드로 간다", async () => {
    const c = await seedCycle();
    const deps = makeDeps();
    const body = await readJson(
      await handleJoinButton(makeComponentInteraction("join:2026-07-20", { userId: "u5" }), deps)
    );
    expect(body).toEqual({ type: 6 }); // 무응답 ACK
    expect((await q.listParticipants(env.DB, c.id)).map((p) => p.joined_via)).toEqual(["button"]);

    await waitOnExecutionContext(deps.ctx);
    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].args[0]).toBe("thread-A");
    const content = JSON.stringify(deps.calls[0].args[1]);
    expect(content).toContain("<@u5>");
    expect(content).toContain("(현재 1명)");
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
