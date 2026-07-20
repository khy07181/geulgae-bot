const BASE = "https://discord.com/api/v10";

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class DiscordApi {
  constructor(
    private token: string,
    private fetcher: Fetcher = fetch
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
    } catch {
      // 네트워크 오류 → 아래에서 1회 재시도
    }
    if (!res || res.status >= 500 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 300));
      res = await doFetch();
    }
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
