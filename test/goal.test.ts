import { env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handleGoal, parseMentions } from "../src/interactions/goal";
import { CHANNEL_ID, makeCommandInteraction, makeDeps, readJson } from "./helpers";

function goalInteraction(
  참여자: string,
  extra: { 개수?: number; 벌금?: number; 주차?: string } = {}
) {
  const options = [{ name: "참여자", type: 3, value: 참여자 }];
  if (extra.개수 !== undefined) options.push({ name: "개수", type: 4, value: extra.개수 } as never);
  if (extra.벌금 !== undefined) options.push({ name: "벌금", type: 4, value: extra.벌금 } as never);
  if (extra.주차 !== undefined) options.push({ name: "주차", type: 3, value: extra.주차 } as never);
  return makeCommandInteraction("목표설정", options);
}

describe("parseMentions", () => {
  it("<@id>와 <@!id>를 파싱하고 중복 제거", () => {
    expect(parseMentions("<@111> 글 <@!222> <@111>")).toEqual(["111", "222"]);
    expect(parseMentions("멘션 없음")).toEqual([]);
  });
});

describe("/목표설정", () => {
  it("신규: 조용한 처리 + 공지 → 스레드 → 사이클 → 시작 안내 순으로 생성", async () => {
    const deps = makeDeps();
    const body = await readJson(await handleGoal(goalInteraction("<@111> <@222>", { 개수: 2 }), deps));
    expect(body.type).toBe(5); // 성공 응답 대신 채널 공지가 공개 기록

    await waitOnExecutionContext(deps.ctx);
    expect(deps.calls.map((c) => c.method)).toEqual([
      "sendMessage", "createThread", "sendMessage", "deleteOriginalResponse",
    ]);
    expect(deps.calls[0].args[0]).toBe(CHANNEL_ID); // 목표 공지는 채널에
    expect(deps.calls[1].args[2]).toBe("7월 3주차 글쓰기"); // weekLabel("2026-07-20") = "7월 3주차"

    const cycle = await q.getCycleByWeekStart(env.DB, "2026-07-20");
    expect(cycle?.goal_count).toBe(2);
    expect(cycle?.penalty_per_post).toBe(10000);
    expect(cycle?.thread_id).toMatch(/^thread-/); // fakeApi가 만든 스레드 id
    expect((await q.listParticipants(env.DB, cycle!.id)).map((p) => p.user_id)).toEqual(["111", "222"]);
    // 시작 안내는 스레드에, 참여자 멘션 포함
    expect(deps.calls[2].args[0]).toBe(cycle!.thread_id);
    expect(JSON.stringify(deps.calls[2].args[1])).toContain("<@111>");
  });

  it("기존 주차: 참여자 추가 + 명시한 설정만 갱신, 알림은 스레드로", async () => {
    const first = makeDeps();
    await handleGoal(goalInteraction("<@111>"), first);
    await waitOnExecutionContext(first.ctx);

    const deps = makeDeps();
    const body = await readJson(await handleGoal(goalInteraction("<@111> <@333>", { 개수: 3 }), deps));
    expect(body.type).toBe(5);
    await waitOnExecutionContext(deps.ctx);

    const cycle = await q.getCycleByWeekStart(env.DB, "2026-07-20");
    expect(cycle?.goal_count).toBe(3);
    expect(cycle?.penalty_per_post).toBe(10000); // 벌금은 안 줬으니 유지
    expect((await q.listParticipants(env.DB, cycle!.id)).map((p) => p.user_id)).toEqual(["111", "333"]);
    // 새로 합류한 333과 설정 변경 내용을 스레드에 안내 (기존 111은 멘션 안 함)
    const notice = deps.calls.find((c) => c.method === "sendMessage");
    expect(notice?.args[0]).toBe(cycle!.thread_id);
    expect(JSON.stringify(notice?.args[1])).toContain("<@333>");
    expect(JSON.stringify(notice?.args[1])).not.toContain("<@111>");
    expect(JSON.stringify(notice?.args[1])).toContain("설정 갱신");
  });

  it("기존 주차: 아무 변화가 없으면 본인에게만 안내", async () => {
    const first = makeDeps();
    await handleGoal(goalInteraction("<@111>"), first);
    await waitOnExecutionContext(first.ctx);

    const body = await readJson(await handleGoal(goalInteraction("<@111>"), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("없어요");
  });

  it("주차:다음주는 다음 주 월요일로 생성", async () => {
    const deps = makeDeps();
    await handleGoal(goalInteraction("<@111>", { 주차: "다음주" }), deps);
    await waitOnExecutionContext(deps.ctx);
    expect(await q.getCycleByWeekStart(env.DB, "2026-07-27")).not.toBeNull();
  });

  it("참여자 멘션이 없으면 ephemeral", async () => {
    const body = await readJson(await handleGoal(goalInteraction("아무도 없음"), makeDeps()));
    expect(body.data.flags).toBe(64);
  });

  it("개수 0은 거부", async () => {
    const body = await readJson(await handleGoal(goalInteraction("<@111>", { 개수: 0 }), makeDeps()));
    expect(body.data.flags).toBe(64);
  });
});
