import { env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handleSubmit } from "../src/interactions/submit";
import {
  CHANNEL_ID, DEFAULT_NOW, fetcherReturning, makeCommandInteraction, makeDeps, readJson,
} from "./helpers";

const NOW_ISO = DEFAULT_NOW.toISOString();

async function seedCycle(weekStart: string, threadId: string, goalCount = 1) {
  return q.createCycle(env.DB, {
    weekStart, goalCount, penaltyPerPost: 10000,
    channelId: CHANNEL_ID, threadId, createdBy: "user:u1", createdAt: NOW_ISO,
  });
}

function submitInteraction(url: string, opts: Parameters<typeof makeCommandInteraction>[2] = {}) {
  return makeCommandInteraction("인증", [{ name: "링크", type: 3, value: url }], opts);
}

describe("/인증", () => {
  it("참여자의 인증: 공개 응답 + 저장 + 백그라운드 검증 후 스레드 후속 메시지", async () => {
    const c = await seedCycle("2026-07-20", "thread-A");
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const deps = makeDeps();
    const res = await handleSubmit(submitInteraction("https://Blog.com/post/"), deps);
    const body = await readJson(res);
    expect(body.data.flags).toBeUndefined(); // 공개
    expect(body.data.content).toContain("1/1개");

    await waitOnExecutionContext(deps.ctx);
    const row = await env.DB.prepare("SELECT * FROM submissions WHERE user_id = 'u1'")
      .first<{ url: string; fetch_status: string; fetch_title: string }>();
    expect(row?.url).toBe("https://blog.com/post"); // 정규화 저장
    expect(row?.fetch_status).toBe("ok");
    expect(row?.fetch_title).toBe("테스트 글");
    const followup = deps.calls.find((c2) => c2.method === "sendMessage");
    expect(followup?.args[0]).toBe("thread-A");
  });

  it("같은 링크 재제출은 ephemeral 거부", async () => {
    const c = await seedCycle("2026-07-20", "thread-A");
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    await handleSubmit(submitInteraction("https://a.com/p"), makeDeps());
    const body = await readJson(await handleSubmit(submitInteraction("https://a.com/p"), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("이미 인증한 링크");
  });

  it("비참여자는 자동으로 참여자 등록 후 인증된다", async () => {
    await seedCycle("2026-07-20", "thread-A");
    const body = await readJson(
      await handleSubmit(submitInteraction("https://a.com/p2", { userId: "u9" }), makeDeps())
    );
    expect(body.data.content).toContain("자동 등록");
    const parts = await q.listParticipants(env.DB, (await q.getCycleByWeekStart(env.DB, "2026-07-20"))!.id);
    expect(parts).toEqual([{ user_id: "u9", joined_via: "submit" }]);
  });

  it("사이클이 없으면 ephemeral 안내", async () => {
    const body = await readJson(await handleSubmit(submitInteraction("https://a.com/p"), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("/목표설정");
  });

  it("다음 주 스레드 안에서 인증하면 그 주에 귀속된다 (미리 인증)", async () => {
    await seedCycle("2026-07-20", "thread-A");
    const next = await seedCycle("2026-07-27", "thread-B");
    const i = submitInteraction("https://a.com/next-week", { channelId: "thread-B", parentId: CHANNEL_ID });
    const body = await readJson(await handleSubmit(i, makeDeps()));
    expect(body.data.flags).toBeUndefined();
    const counts = await q.countSubmissionsByUser(env.DB, next.id);
    expect(counts.get("u1")).toBe(1);
  });

  it("마감이 지난 주차의 스레드에서는 거부", async () => {
    await seedCycle("2026-07-13", "thread-OLD"); // 지난주 (DEFAULT_NOW 기준 마감 지남)
    const i = submitInteraction("https://a.com/late", { channelId: "thread-OLD", parentId: CHANNEL_ID });
    const body = await readJson(await handleSubmit(i, makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("마감");
  });

  it("링크 접속 실패여도 인증은 유효, 스레드에 실패 안내", async () => {
    const c = await seedCycle("2026-07-20", "thread-A");
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const deps = makeDeps({ fetcher: fetcherReturning(500) });
    const body = await readJson(await handleSubmit(submitInteraction("https://dead.com/p"), deps));
    expect(body.data.content).toContain("1/1개"); // 인증 자체는 성공
    await waitOnExecutionContext(deps.ctx);
    const row = await env.DB.prepare("SELECT fetch_status FROM submissions WHERE url = 'https://dead.com/p'")
      .first<{ fetch_status: string }>();
    expect(row?.fetch_status).toBe("failed");
    const followup = deps.calls.find((c2) => c2.method === "sendMessage");
    expect(JSON.stringify(followup?.args[1])).toContain("인증은 유효");
  });

  it("http 링크는 ephemeral 거부", async () => {
    await seedCycle("2026-07-20", "thread-A");
    const body = await readJson(await handleSubmit(submitInteraction("http://a.com/p"), makeDeps()));
    expect(body.data.flags).toBe(64);
  });

  it("카테고리에 속한 인증 채널(메인)에서도 현재 주차로 귀속된다", async () => {
    const c = await seedCycle("2026-07-20", "thread-A");
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    // makeCommandInteraction 기본값이 카테고리 parent_id를 갖는다 — 명시적으로도 고정
    const i = submitInteraction("https://a.com/category-case");
    expect(i.channel?.parent_id).toBe("category-1");
    const body = await readJson(await handleSubmit(i, makeDeps()));
    expect(body.data.flags).toBeUndefined();
    expect(body.data.content).toContain("1/1개");
  });

  it("비참여자의 중복 재제출은 거부되고 유령 참여자로 남지 않는다", async () => {
    const old = await seedCycle("2026-07-13", "thread-OLD");
    await q.insertSubmission(env.DB, {
      cycleId: old.id, userId: "u9", url: "https://a.com/old-post", submittedAt: NOW_ISO,
    });
    const current = await seedCycle("2026-07-20", "thread-A");
    const body = await readJson(
      await handleSubmit(submitInteraction("https://a.com/old-post", { userId: "u9" }), makeDeps())
    );
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("이미 인증한 링크");
    expect(await q.listParticipants(env.DB, current.id)).toEqual([]); // 유령 참여자 없음
  });

  it("res.ok 이후 본문 읽기가 실패해도 failed로 기록된다", async () => {
    const c = await seedCycle("2026-07-20", "thread-A");
    await q.addParticipant(env.DB, c.id, "u1", "manual", NOW_ISO);
    const bodyFailFetcher: typeof fetch = async () => {
      const res = new Response("ignored", { status: 200 });
      Object.defineProperty(res, "text", {
        value: () => Promise.reject(new TypeError("body stream timeout")),
      });
      return res;
    };
    const deps = makeDeps({ fetcher: bodyFailFetcher });
    await handleSubmit(submitInteraction("https://slow.com/p"), deps);
    await waitOnExecutionContext(deps.ctx);
    const row = await env.DB.prepare("SELECT fetch_status FROM submissions WHERE url = 'https://slow.com/p'")
      .first<{ fetch_status: string }>();
    expect(row?.fetch_status).toBe("failed");
    const followup = deps.calls.find((c2) => c2.method === "sendMessage");
    expect(JSON.stringify(followup?.args[1])).toContain("인증은 유효");
  });
});
