import type { IncomingMessage } from "node:http";

/**
 * Production configuration is managed through the server environment only.
 * A loopback peer may be a reverse proxy, so its address alone is not proof
 * that the browser belongs to the operator.
 */
export function canManageLlm(request: Pick<IncomingMessage, "headers" | "socket">, nodeEnv = process.env.NODE_ENV): boolean {
  if (nodeEnv === "production") return false;

  const address = request.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  if (Object.keys(request.headers).some((key) =>
    key === "forwarded" || key === "via" || key === "cf-connecting-ip" || key.startsWith("x-forwarded-"),
  )) return false;

  const host = request.headers.host;
  if (!host) return false;
  let localUrl: URL;
  try {
    localUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (localUrl.host !== host || !["localhost", "127.0.0.1", "[::1]"].includes(localUrl.hostname)) return false;
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== localUrl.origin) return false;
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}
