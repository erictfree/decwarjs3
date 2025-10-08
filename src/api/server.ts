import express from "express";
import type { Request, Response } from "express";
import cors from "cors";

import type { GameStateProvider } from "./provider.js";

/**
 * Start the read-only API server with a provider injected from the game process.
 * The API stays decoupled from game internals (no game imports here).
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

    const port = Number(process.env.API_PORT ?? opts?.port ?? 3001);
    return app.listen(port, () => {
        console.log(`[api] listening on http://localhost:${port}`);
    });
}
