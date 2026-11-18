import type { AiBinding } from "../types";

// PAGE-011: 키워드 추출은 Workers AI(바인딩, npm 의존성 아님).
// 이 모듈이 AI로 나가는 유일한 관문이다. 본문은 여기서만 다루고 저장하지 않는다(PAGE-012).
//
// 아래 값들은 구현 임시값 — 보고 후 확정:
export const KEYWORD_MODEL = "@cf/meta/llama-3.1-8b-instruct";
export const KEYWORD_MAX_COUNT = 5; // 글당 최대 키워드 수
export const KEYWORD_MAX_LENGTH = 20; // 키워드 한 개의 최대 길이(초과분은 모델이 문장을 뱉은 것으로 보고 버림)
export const KEYWORD_BODY_MAX_CHARS = 3000; // 프롬프트에 넣는 본문 길이 상한

// HTML에서 본문 텍스트만 거칠게 추출한다. 제목 수집(fetch)과 같은 응답을 재사용한다.
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// 모델 응답에서 키워드 배열을 관대하게 파싱한다. JSON 배열 → 실패 시 구분자 분리.
// 길이·개수 클램프가 "본문 조각이 DB로 흘러들지 않는다"는 경계를 함께 보장한다.
export function parseKeywords(raw: string): string[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  let items: unknown[] = [];
  const arr = text.match(/\[[\s\S]*?\]/);
  if (arr) {
    try {
      const parsed: unknown = JSON.parse(arr[0]);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      // JSON이 아니면 아래 구분자 분리로 넘어간다
    }
  }
  if (items.length === 0) items = text.split(/[,\n·]/);

  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const k = item
      .replace(/^[\s"'`#\-*\d.)\][]+/, "")
      .replace(/[\s"'`\][]+$/, "")
      .trim();
    if (!k || k.length > KEYWORD_MAX_LENGTH) continue;
    if (!out.includes(k)) out.push(k);
    if (out.length >= KEYWORD_MAX_COUNT) break;
  }
  return out;
}

interface AiTextResponse {
  response?: unknown;
}

// 제목+본문에서 키워드를 추출한다. 실패는 throw — 호출부가 삼키고 제출은 그대로 진행(PAGE-011).
export async function extractKeywords(
  ai: AiBinding,
  title: string | null,
  bodyText: string
): Promise<string[]> {
  const body = bodyText.slice(0, KEYWORD_BODY_MAX_CHARS);
  const res = (await ai.run(KEYWORD_MODEL, {
    messages: [
      {
        role: "system",
        content: "너는 블로그 글의 핵심 주제를 뽑는 도구다. 항상 JSON 배열 하나만 출력한다.",
      },
      {
        role: "user",
        content: `다음 글의 주제를 나타내는 키워드를 2~${KEYWORD_MAX_COUNT}개 뽑아라.
- 각 키워드는 10자 이내의 한국어 명사구 (고유명사·기술 용어는 원어 표기 허용)
- 글에서 실제로 다룬 주제만. 추측하지 않는다
- 출력은 JSON 배열만: ["키워드", ...]

제목: ${title ?? "(없음)"}
본문: ${body}`,
      },
    ],
    max_tokens: 150,
  })) as AiTextResponse | null;
  const raw = res && typeof res === "object" && "response" in res ? String(res.response ?? "") : "";
  return parseKeywords(raw);
}
