const EPHEMERAL_FLAG = 64;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

export function pong(): Response {
  return json({ type: 1 });
}

export function publicMessage(content: string, extra: Record<string, unknown> = {}): Response {
  return json({ type: 4, data: { content, ...extra } });
}

export function ephemeral(content: string): Response {
  return json({ type: 4, data: { content, flags: EPHEMERAL_FLAG } });
}

// "조용한 처리"용: 본인에게만 보이는 "생각 중..." 상태로 응답해두고,
// 백그라운드 작업이 끝나면 원본을 삭제(무흔적)하거나 에러 안내로 편집한다.
export function deferredEphemeral(): Response {
  return json({ type: 5, data: { flags: EPHEMERAL_FLAG } });
}

// 버튼(컴포넌트) 전용 무응답 ACK — 아무 메시지도 만들지 않는다.
export function deferredUpdate(): Response {
  return json({ type: 6 });
}
