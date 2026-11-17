import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import { handleNickname, NICKNAME_MAX_LENGTH } from "../src/interactions/nickname";
import { makeCommandInteraction, makeDeps, readJson } from "./helpers";

function nickInteraction(name: string, userId = "u1") {
  return makeCommandInteraction("닉네임", [{ name: "이름", type: 3, value: name }], { userId });
}

describe("/닉네임", () => {
  it("본인 닉네임을 등록하고 공개 응답한다 (멘션 알림은 끈다)", async () => {
    const body = await readJson(await handleNickname(nickInteraction("하영"), makeDeps()));
    expect(body.type).toBe(4);
    expect(body.data.flags).toBeUndefined();
    expect(body.data.content).toContain("하영");
    expect(body.data.allowed_mentions).toEqual({ parse: [] });
    expect((await q.getNicknames(env.DB)).get("u1")).toBe("하영");
  });

  it("다시 등록하면 덮어쓴다", async () => {
    await handleNickname(nickInteraction("하영"), makeDeps());
    await handleNickname(nickInteraction("글쓰는하영"), makeDeps());
    const names = await q.getNicknames(env.DB);
    expect(names.get("u1")).toBe("글쓰는하영");
    expect(names.size).toBe(1);
  });

  it("실행자 본인 것만 바뀐다 (BOT-002)", async () => {
    await handleNickname(nickInteraction("하영", "u1"), makeDeps());
    await handleNickname(nickInteraction("민희", "u2"), makeDeps());
    const names = await q.getNicknames(env.DB);
    expect(names.get("u1")).toBe("하영");
    expect(names.get("u2")).toBe("민희");
  });

  it("공백뿐인 이름은 거부(ephemeral)", async () => {
    const body = await readJson(await handleNickname(nickInteraction("   "), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect((await q.getNicknames(env.DB)).size).toBe(0);
  });

  it("길이 제한을 넘으면 거부", async () => {
    const body = await readJson(await handleNickname(nickInteraction("가".repeat(NICKNAME_MAX_LENGTH + 1)), makeDeps()));
    expect(body.data.flags).toBe(64);
    expect((await q.getNicknames(env.DB)).size).toBe(0);
  });

  it("앞뒤 공백은 잘라서 저장한다", async () => {
    await handleNickname(nickInteraction("  하영  "), makeDeps());
    expect((await q.getNicknames(env.DB)).get("u1")).toBe("하영");
  });
});
