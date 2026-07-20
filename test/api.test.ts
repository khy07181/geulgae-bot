import { describe, expect, it } from "vitest";
import { DiscordApi, type Fetcher } from "../src/discord/api";

function fetcherWithStatuses(statuses: number[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetcher: Fetcher = async (input, init) => {
    seen.push({ url: String(input), init: init ?? {} });
    const status = statuses[Math.min(seen.length - 1, statuses.length - 1)];
    return new Response(status === 204 ? null : JSON.stringify({ id: "42" }), { status });
  };
  return { fetcher, seen };
}

describe("DiscordApi", () => {
  it("성공 시 Bot 토큰 헤더로 호출하고 JSON을 돌려준다", async () => {
    const { fetcher, seen } = fetcherWithStatuses([200]);
    const api = new DiscordApi("tok", fetcher);
    const msg = await api.sendMessage("chan-1", { content: "hi" });
    expect(msg).toEqual({ id: "42" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://discord.com/api/v10/channels/chan-1/messages");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bot tok");
  });
  it("5xx면 1회 재시도 후 성공", async () => {
    const { fetcher, seen } = fetcherWithStatuses([500, 200]);
    const api = new DiscordApi("tok", fetcher);
    await api.sendMessage("chan-1", { content: "hi" });
    expect(seen).toHaveLength(2);
  });
  it("재시도까지 실패하면 throw", async () => {
    const { fetcher, seen } = fetcherWithStatuses([500, 500]);
    const api = new DiscordApi("tok", fetcher);
    await expect(api.sendMessage("chan-1", { content: "hi" })).rejects.toThrow("실패: 500");
    expect(seen).toHaveLength(2);
  });
  it("4xx(429 제외)는 재시도 없이 즉시 throw", async () => {
    const { fetcher, seen } = fetcherWithStatuses([404]);
    const api = new DiscordApi("tok", fetcher);
    await expect(api.sendMessage("chan-1", { content: "hi" })).rejects.toThrow("실패: 404");
    expect(seen).toHaveLength(1);
  });
  it("createThread는 메시지에 스레드를 만든다", async () => {
    const { fetcher, seen } = fetcherWithStatuses([200]);
    const api = new DiscordApi("tok", fetcher);
    await api.createThread("chan-1", "msg-9", "7월 3주차 글쓰기");
    expect(seen[0].url).toBe("https://discord.com/api/v10/channels/chan-1/messages/msg-9/threads");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ name: "7월 3주차 글쓰기", auto_archive_duration: 10080 });
  });
});
