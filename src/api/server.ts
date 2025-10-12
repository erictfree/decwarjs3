// src/api/server.ts
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";

import type { GameStateProvider } from "./provider.js";
import { gameEvents, type EventType } from "./events.js";

/**
 * Start the read-only API server with a provider injected from the game process.
 * The API stays decoupled from game internals (no game imports here, only the event hub).
 */
export function startApiServer(provider: GameStateProvider, opts?: { port?: number }) {
    const app = express();
    app.use(cors());
    app.use(express.json());

    app.get("/api/health", (_req: Request, res: Response) => {
        res.json({ ok: true });
    });

    app.get("/api/summary", (_req: Request, res: Response) => {
        res.json(provider.getSummary());
    });

    app.get("/api/players", (_req: Request, res: Response) => {
        res.json(provider.listPlayers());
    });

    app.get("/api/planets", (_req: Request, res: Response) => {
        res.json(provider.listPlanets());
    });

    app.get("/api/stars", (_req: Request, res: Response) => {
        res.json(provider.listStars());
    });

    app.get("/api/blackholes", (_req: Request, res: Response) => {
        res.json(provider.listBlackholes());
    });

    app.get("/api/bases", (_req: Request, res: Response) => {
        res.json(provider.listBases());
    });

    /* -------------------------
     * LIVE EVENTS (SSE + snapshot)
     * ------------------------- */

    // GET /api/events
    //   ?types=phaser,torpedo      (optional filter)
    //   ?since=1234                (optional catch-up; or use Last-Event-ID)
    app.get("/api/events", (req, res) => {
        // SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        const typeParam = (req.query.types as string | undefined) ?? "";
        const typesArr = typeParam
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean) as EventType[];

        const sinceQs = req.query.since ? Number(req.query.since) : undefined;
        const sinceHeader = req.header("Last-Event-ID")
            ? Number(req.header("Last-Event-ID"))
            : undefined;
        const since = Number.isFinite(sinceQs)
            ? sinceQs
            : Number.isFinite(sinceHeader)
                ? sinceHeader
                : undefined;

        // Helper to write SSE event
        const send = (evt: any) => {
            res.write(`event: ${evt.type}\n`);
            res.write(`id: ${evt.id}\n`);
            res.write(`data: ${JSON.stringify(evt)}\n\n`);
        };

        // Initial replay (if any)
        const replay = gameEvents.getSince(since, typesArr.length ? typesArr : undefined);
        for (const evt of replay) send(evt);

        // Subscribe to new events
        const unsub = gameEvents.subscribe((evt) => {
            if (typesArr.length && !typesArr.includes(evt.type)) return;
            send(evt);
        });

        // Heartbeat
        const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);

        // Cleanup
        req.on("close", () => {
            clearInterval(heartbeat);
            unsub();
        });
    });

    // GET /api/events/snapshot?since=123&types=a,b
    app.get("/api/events/snapshot", (req, res) => {
        const since = req.query.since ? Number(req.query.since) : undefined;

        const typeParam = (req.query.types as string | undefined) ?? "";
        const typesArr = typeParam
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean) as EventType[];

        const events = gameEvents.getSince(
            Number.isFinite(since) ? since : undefined,
            typesArr.length ? typesArr : undefined
        );

        // Compute latest id from the entire buffer, not just filtered set
        const globalLatest = gameEvents.getSince(undefined).slice(-1)[0]?.id ?? 0;

        res.json({
            latest: globalLatest,
            count: events.length,
            events,
        });
    });

    const port = Number(process.env.API_PORT ?? opts?.port ?? 3001);
    return app.listen(port, () => {
        console.log(`[api] listening on http://localhost:${port}`);
    });
}
