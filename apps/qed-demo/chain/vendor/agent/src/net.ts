/** Minimal JSON-over-HTTP between agent processes (no framework, bigint-safe). */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fromJson, toJson } from "./protocol/eip712.js";

export type Handler = (body: any, req: IncomingMessage) => Promise<unknown>;

export function serve(port: number, routes: Record<string, Handler>, name: string) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const key = `${req.method} ${req.url?.split("?")[0]}`;
    const h = routes[key];
    if (!h) {
      res.writeHead(404).end(toJson({ error: `no route ${key}` }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const out = await h(raw ? fromJson(raw) : {}, req);
      res.writeHead(200, { "content-type": "application/json" }).end(toJson(out));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(toJson({ error: (e as Error).message }));
    }
  });
  return new Promise<typeof server>((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      console.log(`[${name}] listening on 127.0.0.1:${port}`);
      resolve(server);
    }),
  );
}

export async function call<T>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : toJson(body),
  });
  const text = await r.text();
  const parsed = fromJson<any>(text);
  if (!r.ok) throw new Error(parsed?.error ?? `HTTP ${r.status}`);
  return parsed as T;
}

export async function waitFor(url: string, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`service at ${url} did not start`);
}
