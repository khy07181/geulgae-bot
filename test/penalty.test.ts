import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handlePenaltyAdjust, handlePenaltyStatus } from "../src/interactions/penalty";
import { makeCommandInteraction, makeDeps, readJson } from "./helpers";

function adjustInteraction(target: string, amount: number, reason?: string) {
  const options = [
    { name: "대상", type: 6, value: target },
    { name: "금액", type: 4, value: amount },
  ];
  if (reason !== undefined) options.push({ name: "사유", type: 3, value: reason } as never);
  return makeCommandInteraction("벌금조정", options, { userId: "admin" });
}

describe("/벌금현황", () => {
  it("벌금이 없으면 축하 메시지", async () => {
    const body = await readJson(await handlePenaltyStatus(makeCommandInteraction("벌금현황"), makeDeps()));
    expect(body.data.content).toContain("없어요");
  });
  it("멤버별 잔액과 총액을 보여주고 멘션 알림은 끈다", async () => {
    await q.insertAdjustment(env.DB, { userId: "u1", amount: 20000, reason: "이월", createdBy: "user:admin", createdAt: "2026-07-20T00:00:00Z" });
    await q.insertAdjustment(env.DB, { userId: "u2", amount: 10000, reason: null, createdBy: "user:admin", createdAt: "2026-07-20T00:00:00Z" });
    const body = await readJson(await handlePenaltyStatus(makeCommandInteraction("벌금현황"), makeDeps()));
    expect(body.data.content).toContain("<@u1>님: 20,000원");
    expect(body.data.content).toContain("<@u2>님: 10,000원");
    expect(body.data.content).toContain("30,000원");
    expect(body.data.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("/벌금조정", () => {
  it("원장에 조정 행을 남기고 잔액을 알려준다", async () => {
    const body = await readJson(await handlePenaltyAdjust(adjustInteraction("u1", 15000, "기존 봇 이월"), makeDeps()));
    expect(body.data.content).toContain("+15,000원");
    expect(body.data.content).toContain("기존 봇 이월");
    expect(body.data.content).toContain("15,000원");
    const row = await env.DB.prepare("SELECT * FROM penalty_entries WHERE user_id = 'u1'")
      .first<{ kind: string; created_by: string; amount: number }>();
    expect(row).toMatchObject({ kind: "adjustment", created_by: "user:admin", amount: 15000 });
  });
  it("음수 조정(납부·삭감)이 잔액에 반영된다", async () => {
    await handlePenaltyAdjust(adjustInteraction("u1", 20000), makeDeps());
    const body = await readJson(await handlePenaltyAdjust(adjustInteraction("u1", -5000), makeDeps()));
    expect(body.data.content).toContain("-5,000원");
    expect(await q.getPenaltyBalance(env.DB, "u1")).toBe(15000);
  });
  it("0원은 거부", async () => {
    const body = await readJson(await handlePenaltyAdjust(adjustInteraction("u1", 0), makeDeps()));
    expect(body.data.flags).toBe(64);
  });
});
