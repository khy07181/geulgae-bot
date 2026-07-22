import { describe, expect, it } from "vitest";
import { deferredEphemeral, deferredUpdate, ephemeral, pong, publicMessage } from "../src/discord/replies";

async function body(res: Response) {
  expect(res.headers.get("content-type")).toContain("application/json");
  return JSON.parse(await res.text());
}

describe("replies", () => {
  it("pong은 type 1", async () => {
    expect(await body(pong())).toEqual({ type: 1 });
  });
  it("deferredEphemeral은 type 5 + flags 64", async () => {
    expect(await body(deferredEphemeral())).toEqual({ type: 5, data: { flags: 64 } });
  });
  it("deferredUpdate는 type 6", async () => {
    expect(await body(deferredUpdate())).toEqual({ type: 6 });
  });
  it("publicMessage는 type 4 공개 메시지, extra 병합", async () => {
    expect(await body(publicMessage("안녕", { allowed_mentions: { parse: [] } }))).toEqual({
      type: 4,
      data: { content: "안녕", allowed_mentions: { parse: [] } },
    });
  });
  it("ephemeral은 flags 64", async () => {
    expect(await body(ephemeral("에러"))).toEqual({ type: 4, data: { content: "에러", flags: 64 } });
  });
});
