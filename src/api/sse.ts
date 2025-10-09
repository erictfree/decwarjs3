// src/api/sse.ts
import { Router, type Request, type Response } from "express";
import { gameEvents, type AnyEvent } from "./events.js";

export const sseRouter = Router();

/**
 * GET /api/events
 *  - Live SSE stream.
 *  - Supports Last-Event-ID header or ?since=<id>
 *  - Filter by ?types=phaser,torpedo,planet_captured
 */
sseRouter.get("/events", (req: Request, res: Response) => {
    // CORS should be handled by your server.ts; this path only sets SSE headers
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // allow proxies to stream
    res.flushHeaders?.();

    const sinceParam = req.query.since ? Number(req.query.since) : undefined;
    const lastIdHeader = req.header("Last-Event-ID");
    const since = Number.isFinite(sinceParam) ? sinceParam
        : lastIdHeader ? Number(lastIdHeader)
            : undefined;

    const typesParam = typeof req.query.types === "string" ? req.query.types : undefined;
    const types = typesParam ? (typesParam.split(",").map(s => s.trim()).filter(Boolean) as Array<AnyEvent["type"]>) : undefined;

    // 1) Send backlog (if any)
    const backlog = gameEvents.getSince(since, types);
    for (const e of backlog) writeEvent(res, e);

    // 2) Subscribe to live events
    const sub = gameEvents.subscribe((e) => {
        if (types && !types.includes(e.type)) return;
        writeEvent(res, e);
    });

    // 3) Keepalive
    const ping = setInterval(() => { res.write(`: ping ${Date.now()}\n\n`); }, 25_000);

    // 4) Cleanup
    req.on("close", () => {
        clearInterval(ping);
        sub();
    });
});

function writeEvent(res: Response, e: AnyEvent): void {
    res.write(`id: ${e.id}\n`);
    res.write(`event: ${String(e.type)}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
}
