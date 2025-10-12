// src/api/server.ts
import express, { type Request, type Response } from "express";
import cors from "cors";

import type { GameStateProvider } from "./provider.js";
import { gameEvents, type EventType } from "./events.js";
import { paginate } from "./pagination.js";
import { sseRouter } from "./sse.js";

/**
 * Start the read-only API server with a provider injected from the game process.
 * The API stays decoupled from game internals (no game imports here, only the event hub).
 */
export function startApiServer(provider: GameStateProvider, opts?: { port?: number }) {
    const app = express();
    app.use(cors());
    app.use(express.json());

    // ---- basic state endpoints ----
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

    // Mount the SSE router at /api so GET /api/events streams live events
    app.use("/api", sseRouter);

    // GET /api/events/snapshot
    //   ?types=phaser,torpedo            (optional filter)
    //   ?since=1234                      (optional catch-up id)
    //   ?page=1&pageSize=200             (optional pagination)
    app.get("/api/events/snapshot", (req: Request, res: Response) => {
        const sinceRaw = req.query.since as string | undefined;
        const sinceNum = sinceRaw ? Number(sinceRaw) : undefined;
        const since = Number.isFinite(sinceNum!) ? (sinceNum as number) : undefined;

        const typesRaw = (req.query.types as string | undefined) ?? "";
        const typesArr = typesRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean) as EventType[];

        // pagination with sane bounds
        const pageRaw = req.query.page as string | undefined;
        const pageSizeRaw = req.query.pageSize as string | undefined;
        const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);
        const requestedPageSize = Number.isFinite(Number(pageSizeRaw)) ? Number(pageSizeRaw) : 100;
        const pageSize = Math.min(Math.max(1, requestedPageSize), 1000);

        const events = gameEvents.getSince(
            since,
            typesArr.length ? typesArr : undefined
        );

        // latest id from entire buffer (prefer helper if present)
        const globalLatest =
            typeof (gameEvents as any).latestId === "function"
                ? (gameEvents as any).latestId()
                : gameEvents.getSince(undefined).slice(-1)[0]?.id ?? 0;

        const result = paginate(events, { page, pageSize, maxPageSize: 1000 });

        res.json({
            latest: globalLatest,
            count: result.total,
            page: result.page,
            pageSize: result.pageSize,
            events: result.items,
        });
    });

    const port = Number(process.env.API_PORT ?? opts?.port ?? 3001);
    return app.listen(port, () => {
        console.log(`[api] listening on http://localhost:${port}`);
    });
}
