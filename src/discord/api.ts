const BASE = "https://discord.com/api/v10";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class DiscordApi {
  constructor(
    private token: string,
    // 전역 fetch를 그대로 담으면 this.fetcher(...) 호출 시 this가 인스턴스로 바인딩되어
    // workerd가 "Illegal invocation"을 던진다 — 반드시 화살표로 감싼다.
    private fetcher: Fetcher = (input, init) => fetch(input, init)
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const doFetch = () =>
      this.fetcher(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let res: Response | undefined;
    try {
      res = await doFetch();
    } catch (err) {
      console.error(`Discord API ${method} ${path} 1차 시도 예외:`, err);
      // 네트워크 오류 → 아래에서 1회 재시도
    }
    if (!res || res.status >= 500 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        res = await doFetch();
      } catch (err) {
        console.error(`Discord API ${method} ${path} 재시도 예외:`, err);
        res = undefined;
      }
    }
    if (!res) throw new Error(`Discord API ${method} ${path} 실패: 네트워크 오류`);
    if (!res.ok) throw new Error(`Discord API ${method} ${path} 실패: ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  sendMessage(
    channelId: string,
    payload: { content: string; components?: unknown[]; allowed_mentions?: unknown }
  ): Promise<{ id: string }> {
    return this.request("POST", `/channels/${channelId}/messages`, payload) as Promise<{ id: string }>;
  }

  createThread(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
    return this.request("POST", `/channels/${channelId}/messages/${messageId}/threads`, {
      name,
      auto_archive_duration: 10080,
    }) as Promise<{ id: string }>;
  }
}
