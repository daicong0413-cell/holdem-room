/** Fail visibly when a static-only deployment returns HTML instead of the game API. */
export async function readBackendJson<T>(path: string, signal?: AbortSignal, request: typeof fetch = fetch): Promise<T> {
  const response = await request(path, { signal });
  if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`${path} 未返回游戏服务数据`);
  }
  return response.json() as Promise<T>;
}
