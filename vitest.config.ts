import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults } from "vitest/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(process.cwd(), "migrations"));
  return {
    test: {
      // Claude 세션 워크트리 사본(.claude/worktrees/*)이 테스트를 이중으로 돌리지 않게 제외
      exclude: [...configDefaults.exclude, "**/.claude/**"],
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
