import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { DiscordApi } from "../src/discord/api";
import { runScheduledJob } from "../src/jobs/run";
import type { JobDeps } from "../src/jobs/settle";
import { CHANNEL_ID, DEFAULT_NOW, fakeApi, makeEnv } from "./helpers";

// 어떤 쿼리든 즉시 던지는 DB — 잡 실패 경로를 강제한다.
const brokenDb = {
  prepare() {
    throw new Error("D1 `폭발`");
  },
} as unknown as D1Database;

function jobDeps(api: DiscordApi, db: D1Database): JobDeps {
  return { env: makeEnv(), db, api, now: () => DEFAULT_NOW };
}

describe("runScheduledJob", () => {
  it("잡이 던지면 인증 채널에 실패 알림을 남기고 다시 던진다", async () => {
    const fake = fakeApi();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runScheduledJob("1 15 * * *", jobDeps(fake.api, brokenDb))).rejects.toThrow("폭발");
    errSpy.mockRestore();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].args[0]).toBe(CHANNEL_ID);
    const body = JSON.stringify(fake.calls[0].args[1]);
    expect(body).toContain("정산 sweep");
    expect(body).toContain("D1 '폭발'"); // 백틱은 코드 스팬이 깨지지 않게 치환된다
  });

  it("알림 전송까지 실패해도 원래 에러를 던진다", async () => {
    const api = {
      async sendMessage() {
        throw new Error("Discord down");
      },
    } as unknown as DiscordApi;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runScheduledJob("1 15 * * *", jobDeps(api, brokenDb))).rejects.toThrow("폭발");
    errSpy.mockRestore();
  });

  it("알 수 없는 cron은 아무 일도 하지 않는다", async () => {
    const fake = fakeApi();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runScheduledJob("9 9 * * *", jobDeps(fake.api, brokenDb)); // DB가 망가져 있어도 닿지 않는다
    logSpy.mockRestore();
    expect(fake.calls).toHaveLength(0);
  });

  it("정상 실행이면 알림이 없다", async () => {
    const fake = fakeApi();
    await runScheduledJob("1 15 * * *", jobDeps(fake.api, env.DB)); // 빈 DB → 정산 대상 없음
    expect(fake.calls).toHaveLength(0);
  });
});
