import {
  countDistinctParticipants, getNicknames, listAllCycles, listAllKeywords, listAllParticipants,
  listAllPenaltyEntries, listAllSubmissions,
} from "../db/queries";
import { buildRecap } from "../domain/recap";
import type { Env } from "../types";
import { displayNames, renderArchive, renderRecap } from "./render";

const notFound = () => new Response("Not Found", { status: 404 });
const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

// PAGE-001·PAGE-003·PAGE-004·PAGE-006: 아카이브·결산은 비밀 경로 /s/<PAGE_TOKEN>/ 아래에서만 제공한다.
// 토큰이 미설정이거나 틀리면 404와 동일한 무해 응답. 루트(/)는 기존 무해 응답 유지.
export async function handleGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/") return new Response("geulgae-bot", { status: 200 });

  const m = path.match(/^\/s\/([^/]+)(?:\/(\d{4}))?\/?$/);
  if (!m || !env.PAGE_TOKEN || m[1] !== env.PAGE_TOKEN) return notFound();

  // 상대 링크(아카이브→연도, 결산→아카이브)가 안전하게 풀리도록 경로를 정규화한다:
  // 아카이브는 /s/<토큰>/ (슬래시 있음), 결산은 /s/<토큰>/<연도> (슬래시 없음).
  if (!m[2] && !path.endsWith("/")) return Response.redirect(`${url.origin}${path}/`, 308);
  if (m[2] && path.endsWith("/")) return Response.redirect(`${url.origin}${path.slice(0, -1)}`, 308);

  return m[2] ? recapResponse(env.DB, Number(m[2])) : archiveResponse(env.DB);
}

async function archiveResponse(db: D1Database): Promise<Response> {
  const [cycles, submissions, nicknames, writerCount] = await Promise.all([
    listAllCycles(db), listAllSubmissions(db), getNicknames(db), countDistinctParticipants(db),
  ]);
  return new Response(renderArchive({ cycles, submissions, nicknames, writerCount }), { status: 200, headers: HTML });
}

async function recapResponse(db: D1Database, year: number): Promise<Response> {
  const [cycles, submissions, participants, penalties, nicknames, keywords] = await Promise.all([
    listAllCycles(db), listAllSubmissions(db), listAllParticipants(db), listAllPenaltyEntries(db),
    getNicknames(db), listAllKeywords(db),
  ]);
  const recap = buildRecap({ year, cycles, submissions, participants, penalties, keywords });
  // 익명 라벨은 아카이브와 같은 기준(전체 제출 시간순 첫 등장)으로 배정해 페이지 간에 어긋나지 않게 한다.
  const names = displayNames(submissions.map((s) => s.user_id), nicknames);
  return new Response(renderRecap(recap, names), { status: 200, headers: HTML });
}
