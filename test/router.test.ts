import { describe, expect, it } from "vitest";
import { routeInteraction } from "../src/router";
import { makeCommandInteraction, makeDeps, readJson } from "./helpers";

describe("routeInteraction", () => {
  it("PING에 PONG으로 답한다", async () => {
    const res = await routeInteraction({ id: "1", type: 1, token: "t" }, makeDeps());
    expect(await readJson(res)).toEqual({ type: 1 });
  });
  it("인증 채널 밖에서는 ephemeral 안내", async () => {
    const i = makeCommandInteraction("현황", [], { channelId: "다른채널" });
    const body = await readJson(await routeInteraction(i, makeDeps()));
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("인증 채널");
  });
  it("인증 채널의 하위 스레드는 허용된다 (알 수 없는 명령 응답이 나와야 함)", async () => {
    const i = makeCommandInteraction("없는명령", [], { channelId: "thread-x", parentId: "chan-1" });
    const body = await readJson(await routeInteraction(i, makeDeps()));
    expect(body.data.content).toContain("알 수 없는 명령");
  });
  it("알 수 없는 버튼은 ephemeral", async () => {
    const i = makeCommandInteraction("", []);
    i.type = 3;
    i.data = { custom_id: "mystery:1" };
    const body = await readJson(await routeInteraction(i, makeDeps()));
    expect(body.data.flags).toBe(64);
  });
});
