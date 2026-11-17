import { countDistinctParticipants, getNicknames, listAllCycles, listAllSubmissions } from "../db/queries";
import type { Env } from "../types";
import { renderLibrary } from "./render";

const notFound = () => new Response("Not Found", { status: 404 });

// PAGE-001·PAGE-003·PAGE-004: 서재는 비밀 경로 /s/<PAGE_TOKEN>/ 아래에서만 제공한다.
// 토큰이 미설정이거나 틀리면 404와 동일한 무해 응답. 루트(/)는 기존 무해 응답 유지.
export async function handleGet(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response("geulgae-bot", { status: 200 });

  const m = path.match(/^\/s\/([^/]+)\/?$/);
  if (!m || !env.PAGE_TOKEN || m[1] !== env.PAGE_TOKEN) return notFound();

  const [cycles, submissions, nicknames, writerCount] = await Promise.all([
    listAllCycles(env.DB),
    listAllSubmissions(env.DB),
    getNicknames(env.DB),
    countDistinctParticipants(env.DB),
  ]);
  return new Response(renderLibrary({ cycles, submissions, nicknames, writerCount }), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
