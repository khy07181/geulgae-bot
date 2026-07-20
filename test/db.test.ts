import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";

const NOW = "2026-07-20T03:00:00.000Z";

async function seedCycle(weekStart = "2026-07-20") {
  return q.createCycle(env.DB, {
    weekStart,
    goalCount: 1,
    penaltyPerPost: 10000,
    channelId: "chan-1",
    threadId: `thread-${weekStart}`,
    createdBy: "user:u1",
    createdAt: NOW,
  });
}

describe("cycles", () => {
  it("createCycle 후 week_start와 thread_id로 조회된다", async () => {
    const c = await seedCycle();
    expect(c.id).toBeGreaterThan(0);
    expect((await q.getCycleByWeekStart(env.DB, "2026-07-20"))?.id).toBe(c.id);
    expect((await q.getCycleByThreadId(env.DB, "thread-2026-07-20"))?.id).toBe(c.id);
    expect(await q.getCycleByWeekStart(env.DB, "2000-01-03")).toBeNull();
  });
  it("updateCycleSettings는 준 값만 갱신한다", async () => {
    const c = await seedCycle("2026-07-27");
    await q.updateCycleSettings(env.DB, c.id, { goalCount: 3 });
    const after = await q.getCycleByWeekStart(env.DB, "2026-07-27");
    expect(after?.goal_count).toBe(3);
    expect(after?.penalty_per_post).toBe(10000); // 안 준 값은 유지
  });
});

describe("participants", () => {
  it("addParticipant는 최초 true, 중복 false", async () => {
    const c = await seedCycle("2026-08-03");
    expect(await q.addParticipant(env.DB, c.id, "u1", "manual", NOW)).toBe(true);
    expect(await q.addParticipant(env.DB, c.id, "u1", "button", NOW)).toBe(false);
    await q.addParticipant(env.DB, c.id, "u2", "button", NOW);
    expect((await q.listParticipants(env.DB, c.id)).map((p) => p.user_id)).toEqual(["u1", "u2"]);
    await q.removeParticipant(env.DB, c.id, "u1");
    expect((await q.listParticipants(env.DB, c.id)).map((p) => p.user_id)).toEqual(["u2"]);
  });
});

describe("submissions", () => {
  it("insertSubmission은 같은 (user, url) 중복 시 'duplicate'", async () => {
    const c = await seedCycle("2026-08-10");
    const r1 = await q.insertSubmission(env.DB, {
      cycleId: c.id, userId: "u1", url: "https://a.com/p", submittedAt: NOW,
    });
    expect(r1).not.toBe("duplicate");
    const r2 = await q.insertSubmission(env.DB, {
      cycleId: c.id, userId: "u1", url: "https://a.com/p", submittedAt: NOW,
    });
    expect(r2).toBe("duplicate");
    // 다른 유저의 같은 URL은 허용
    const r3 = await q.insertSubmission(env.DB, {
      cycleId: c.id, userId: "u2", url: "https://a.com/p", submittedAt: NOW,
    });
    expect(r3).not.toBe("duplicate");
    const counts = await q.countSubmissionsByUser(env.DB, c.id);
    expect(counts.get("u1")).toBe(1);
    expect(counts.get("u2")).toBe(1);
  });
  it("setSubmissionFetchResult가 상태·제목을 기록한다", async () => {
    const c = await seedCycle("2026-08-17");
    const r = await q.insertSubmission(env.DB, {
      cycleId: c.id, userId: "u1", url: "https://b.com/p", submittedAt: NOW,
    });
    if (r === "duplicate") throw new Error("unreachable");
    await q.setSubmissionFetchResult(env.DB, r.id, "ok", "글 제목");
    const row = await env.DB.prepare("SELECT fetch_status, fetch_title FROM submissions WHERE id = ?")
      .bind(r.id).first<{ fetch_status: string; fetch_title: string }>();
    expect(row).toEqual({ fetch_status: "ok", fetch_title: "글 제목" });
  });
});

describe("penalty ledger", () => {
  it("정산+조정을 합산하고, 정산 재실행은 무시된다(멱등)", async () => {
    const c = await seedCycle("2026-08-24");
    const entries = [{ userId: "u1", amount: 20000, reason: "2026-08-24 주차 정산" }];
    await q.insertSettlementEntries(env.DB, c.id, entries, NOW);
    await q.insertSettlementEntries(env.DB, c.id, entries, NOW); // 재실행 → OR IGNORE
    await q.insertAdjustment(env.DB, {
      userId: "u1", amount: -5000, reason: null, createdBy: "user:u2", createdAt: NOW,
    });
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(15000);
    expect(await q.getPenaltyBalance(env.DB, "없는사람")).toBe(0);
    expect(await q.getPenaltyBalances(env.DB)).toEqual([{ user_id: "u1", balance: 15000 }]);
  });
  it("listUnsettledCycles / markSettled", async () => {
    const c = await seedCycle("2026-08-31");
    expect((await q.listUnsettledCycles(env.DB)).some((x) => x.id === c.id)).toBe(true);
    await q.markSettled(env.DB, c.id, NOW);
    expect((await q.listUnsettledCycles(env.DB)).some((x) => x.id === c.id)).toBe(false);
  });
});
