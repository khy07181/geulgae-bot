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
