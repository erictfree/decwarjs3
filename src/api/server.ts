// src/api/server.ts
import express, { type Request, type Response } from "express";
import cors from "cors";

import type { GameStateProvider } from "./provider.js";
import { gameEvents, type EventType } from "./events.js";
import { paginate } from "./pagination.js";
import { sseRouter } from "./sse.js";
import { dtoRateLimiter } from "./dtoRateLimiter.js";

/**
 * Start the read-only API server with a provider injected from the game process.
 * The API stays decoupled from game internals (no game imports here, only the event hub).
 */
export function startApiServer(provider: GameStateProvider, opts?: { port?: number }) {
    const app = express();

    // Ensure per-IP works behind proxies/load balancers
    app.set("trust proxy", true);

    app.use(cors());
    app.use(express.json());

    // Strict sliding window limiter:
    // <= 5 requests in any rolling 5-second period per client
    const dtoLimiter = dtoRateLimiter({ max: 5, windowMs: 5000, verbose: true });

    // ---- basic state endpoints ----
    app.get("/api/health", (_req: Request, res: Response) => {
        res.json({ ok: true });
    });

    // DTO endpoints (limited)
    app.get("/api/summary", dtoLimiter, (_req: Request, res: Response) => {
        res.json(provider.getSummary());
    });

    app.get("/api/players", dtoLimiter, (_req: Request, res: Response) => {
        res.json(provider.listPlayers());
    });

    app.get("/api/planets", dtoLimiter, (_req: Request, res: Response) => {
        res.json(provider.listPlanets());
    });

    app.get("/api/stars", dtoLimiter, (_req: Request, res: Response) => {
        res.json(provider.listStars());
    });

    app.get("/api/blackholes", dtoLimiter, (_req: Request, res: Response) => {
        res.json(provider.listBlackholes());
    });

    app.get("/api/bases", dtoLimiter, (_req: Request, res: Response) => {
        res.json(provider.listBases());
    });

    /* -------------------------
     * LIVE EVENTS (SSE + snapshot)
     * ------------------------- */

    // Events API (limited):
    // - GET /api/events        (SSE stream)
    // - GET /api/events/snapshot
    // Apply limiter to the router so SSE connection attempts are limited too.
    app.use("/api", dtoLimiter, sseRouter);

    // GET /api/events/snapshot
    //   ?types=phaser,torpedo            (optional filter)
    //   ?since=1234                      (optional catch-up id)
    //   ?page=1&pageSize=200             (optional pagination)
    app.get("/api/events/snapshot", dtoLimiter, (req: Request, res: Response) => {
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
        const globalLatest = gameEvents.latestId();

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
        console.log(`[api] listening on http://localhost:${port} (DTO RL: ≤5 req / 5s, sliding)`);
    });
}
