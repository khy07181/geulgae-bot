const TRACKING_PARAMS = new Set(["fbclid", "gclid", "igshid"]);

export type UrlResult = { ok: true; url: string } | { ok: false; reason: string };

export function normalizeUrl(raw: string): UrlResult {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "URL 형식이 아니에요. 전체 주소를 붙여넣어 주세요." };
  }
  if (u.protocol !== "https:") {
    return { ok: false, reason: "https:// 로 시작하는 링크만 인증할 수 있어요." };
  }
  for (const key of [...u.searchParams.keys()]) {
    if (key.startsWith("utm_") || TRACKING_PARAMS.has(key)) u.searchParams.delete(key);
  }
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/") path = "";
  const query = u.searchParams.toString();
  const host = u.hostname.toLowerCase() + (u.port ? `:${u.port}` : "");
  return { ok: true, url: `https://${host}${path}${query ? `?${query}` : ""}` };
}
