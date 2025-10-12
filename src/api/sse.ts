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
    // NOTE: CORS should be enabled in server.ts. We only set SSE-specific headers here.
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    // Some proxies need an immediate flush to start streaming
    res.flushHeaders?.();

    // Tell the client how long to wait before retrying the connection (ms)
    res.write(`retry: 5000\n\n`);

    // Determine starting point (either ?since= or Last-Event-ID)
    const sinceParam = req.query.since ? Number(req.query.since) : undefined;
    const lastIdHeader = req.header("Last-Event-ID");
    const since = Number.isFinite(sinceParam)
        ? sinceParam
        : lastIdHeader
            ? Number(lastIdHeader)
            : undefined;

    // Optional type filter: ?types=foo,bar
    const typesParam = typeof req.query.types === "string" ? req.query.types : undefined;
    const types = typesParam
        ? (typesParam.split(",").map((s) => s.trim()).filter(Boolean) as Array<AnyEvent["type"]>)
        : undefined;
    const typeSet = types ? new Set(types) : undefined;

    // 1) Send backlog to catch up
    const backlog = gameEvents.getSince(since, types);
    for (const e of backlog) writeEvent(res, e);

    // 2) Subscribe to live events (explicit param typing to avoid TS7006)
    const sub = gameEvents.subscribe((e: AnyEvent) => {
        if (typeSet && !typeSet.has(e.type)) return;
        writeEvent(res, e);
    });

    // 3) Keepalive comments (helps load balancers / proxies)
    const ping = setInterval(() => {
        res.write(`: ping ${Date.now()}\n\n`);
    }, 25_000);

    // 4) Cleanup on disconnect
    const cleanup = () => {
        clearInterval(ping);
        sub(); // unsubscribe
        try {
            res.end();
        } catch {
            /* noop */
        }
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
});

function writeEvent(res: Response, e: AnyEvent): void {
    res.write(`id: ${e.id}\n`);
    res.write(`event: ${String(e.type)}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
}
