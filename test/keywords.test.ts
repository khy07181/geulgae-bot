import { env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as q from "../src/db/queries";
import {
  KEYWORD_BODY_MAX_CHARS, KEYWORD_MAX_COUNT, KEYWORD_MAX_LENGTH,
  extractKeywords, htmlToText, parseKeywords,
} from "../src/domain/keywords";
import { handleSubmit } from "../src/interactions/submit";
import type { AiBinding } from "../src/types";
import { CHANNEL_ID, DEFAULT_NOW, makeCommandInteraction, makeDeps } from "./helpers";

const NOW_ISO = DEFAULT_NOW.toISOString();

function fakeAi(response: string): { ai: AiBinding; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    ai: {
      async run(_model, options) {
        const messages = (options as { messages: { content: string }[] }).messages;
        prompts.push(messages.map((m) => m.content).join("\n"));
        return { response };
      },
    },
  };
}

async function seedCycle() {
  return q.createCycle(env.DB, {
    weekStart: "2026-07-20", goalCount: 1, penaltyPerPost: 10000,
    channelId: CHANNEL_ID, threadId: "thread-A", createdBy: "user:u1", createdAt: NOW_ISO,
  });
}

const submitInteraction = (url: string) =>
  makeCommandInteraction("인증", [{ name: "링크", type: 3, value: url }]);

describe("htmlToText", () => {
  it("script·style·태그를 제거하고 엔티티를 복원한다", () => {
    const html = `<html><head><style>.a{color:red}</style><script>alert(1)</script></head>
<body><h1>제목</h1><p>달리기와 &amp; 글쓰기</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toBe("제목 달리기와 & 글쓰기");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color");
  });
});

describe("parseKeywords", () => {
  it("JSON 배열을 파싱한다 (코드펜스 포함)", () => {
    expect(parseKeywords('["회고", "러닝"]')).toEqual(["회고", "러닝"]);
    expect(parseKeywords('```json\n["타입스크립트"]\n```')).toEqual(["타입스크립트"]);
    expect(parseKeywords('결과: ["독서", "커리어"] 입니다')).toEqual(["독서", "커리어"]);
  });

  it("JSON이 아니면 줄·콤마 분리로 받아낸다", () => {
    expect(parseKeywords("- 회고\n- 사이드 프로젝트")).toEqual(["회고", "사이드 프로젝트"]);
    expect(parseKeywords("회고, 러닝, 제주")).toEqual(["회고", "러닝", "제주"]);
  });

  it(`개수는 ${KEYWORD_MAX_COUNT}개, 길이는 ${KEYWORD_MAX_LENGTH}자로 클램프하고 중복을 버린다 (PAGE-012 경계)`, () => {
    expect(parseKeywords('["a","b","c","d","e","f","g"]')).toHaveLength(KEYWORD_MAX_COUNT);
    // 길이 초과분은 모델이 문장(본문 조각)을 뱉은 것으로 보고 버린다 → 본문이 DB로 흘러들지 않는다
    const long = "이 글은 아주 길게 요약하면 이런 내용입니다만 키워드는 아닙니다";
    expect(parseKeywords(JSON.stringify([long, "회고", "회고"]))).toEqual(["회고"]);
  });
});

describe("extractKeywords", () => {
  it("제목·본문을 프롬프트에 넣고 응답을 파싱한다 (본문은 상한까지만)", async () => {
    const { ai, prompts } = fakeAi('["글쓰기 루틴", "회고"]');
    const body = "가".repeat(KEYWORD_BODY_MAX_CHARS + 500);
    const result = await extractKeywords(ai, "10월 회고", body);
    expect(result).toEqual(["글쓰기 루틴", "회고"]);
    expect(prompts[0]).toContain("10월 회고");
    expect(prompts[0]).not.toContain("가".repeat(KEYWORD_BODY_MAX_CHARS + 1));
  });
});

describe("/인증 키워드 추출 (PAGE-011)", () => {
  it("제출 시 키워드를 추출해 저장한다 — 본문은 저장하지 않는다 (PAGE-012)", async () => {
    await seedCycle();
    const { ai } = fakeAi('["달리기", "글쓰기"]');
    const deps = makeDeps({ ai });
    await handleSubmit(submitInteraction("https://a.com/run"), deps);
    await waitOnExecutionContext(deps.ctx);

    const rows = await q.listAllKeywords(env.DB);
    expect(rows.map((r) => r.keyword).sort()).toEqual(["글쓰기", "달리기"]);
    // 본문("본문")이 어디에도 저장되지 않는다: keywords에는 클램프된 키워드만, submissions에는 제목만
    const sub = await env.DB.prepare("SELECT fetch_title FROM submissions").first<{ fetch_title: string }>();
    expect(sub?.fetch_title).toBe("테스트 글");
    for (const r of rows) expect(r.keyword.length).toBeLessThanOrEqual(KEYWORD_MAX_LENGTH);
  });

  it("추출이 실패해도 인증·제목 저장은 그대로 진행된다", async () => {
    await seedCycle();
    const ai: AiBinding = { run: async () => { throw new Error("AI down"); } };
    const deps = makeDeps({ ai });
    await handleSubmit(submitInteraction("https://a.com/fail"), deps);
    await waitOnExecutionContext(deps.ctx);

    expect(await q.listAllKeywords(env.DB)).toHaveLength(0);
    const sub = await env.DB.prepare("SELECT fetch_status, fetch_title FROM submissions")
      .first<{ fetch_status: string; fetch_title: string }>();
    expect(sub?.fetch_status).toBe("ok");
    expect(sub?.fetch_title).toBe("테스트 글");
  });

  it("AI 바인딩이 없으면 추출 없이 동작한다", async () => {
    await seedCycle();
    const deps = makeDeps(); // ai 없음
    await handleSubmit(submitInteraction("https://a.com/no-ai"), deps);
    await waitOnExecutionContext(deps.ctx);
    expect(await q.listAllKeywords(env.DB)).toHaveLength(0);
  });
});
