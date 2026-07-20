// Placeholder Worker entry point.
// wrangler.toml declares `main = "src/index.ts"`, and the vitest-pool-workers
// test runtime needs a loadable module here to boot (even for D1-binding-only
// tests). The real fetch/scheduled handlers are implemented in a later task.
export default {
  async fetch() {
    return new Response("Not Implemented", { status: 501 });
  },
};
