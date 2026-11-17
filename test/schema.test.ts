import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("D1 스키마", () => {
  it("테이블 5개가 생성된다", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name != 'd1_migrations' ORDER BY name"
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["cycles", "nicknames", "participants", "penalty_entries", "submissions"]);
  });

  it("정산 멱등 인덱스: 같은 (cycle, user)의 settlement 이중 INSERT는 거부된다", async () => {
    await env.DB.prepare(
      "INSERT INTO cycles (week_start, channel_id, thread_id, created_by, created_at) VALUES ('2026-07-13','c','t','user:1','2026-07-13T00:00:00Z')"
    ).run();
    const insert =
      "INSERT INTO penalty_entries (user_id, amount, kind, cycle_id, created_by, created_at) VALUES ('u1', 10000, 'settlement', 1, 'bot:settlement', '2026-07-20T00:00:00Z')";
    await env.DB.prepare(insert).run();
    await expect(env.DB.prepare(insert).run()).rejects.toThrow();
    // adjustment는 cycle_id 없이 여러 번 가능
    const adj =
      "INSERT INTO penalty_entries (user_id, amount, kind, reason, created_by, created_at) VALUES ('u1', -5000, 'adjustment', NULL, 'user:2', '2026-07-20T00:00:00Z')";
    await env.DB.prepare(adj).run();
    await env.DB.prepare(adj).run(); // 두 번째도 성공해야 함
  });
});
