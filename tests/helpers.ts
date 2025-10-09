/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Player } from "../src/player.js";
import { Ship } from "../src/ship.js";
import { Planet } from "../src/planet.js";
import { MAX_SHIELD_ENERGY } from "../src/settings.js";
import { players, bases, pointsManager } from "../src/game.js";
import { NullSocket } from "../src/util/nullsocket.js";
import { settings } from "../src/settings.js";

export type Side = "FEDERATION" | "EMPIRE" | "ROMULAN" | "NEUTRAL";

/** Freeze Math.random to a sequence during fn, then restore. */
export function withFixedRandom<T>(seq: number[], fn: () => T): T {
    const orig = Math.random;
    let i = 0;
    Math.random = () => {
        const v = seq[i] ?? seq[seq.length - 1] ?? 0.5;
        i += 1;
        return v;
    };
    try {
        return fn();
    } finally {
        Math.random = orig;
    }
}

/** Create a fully-initialized Player with a ship. */
export function makePlayer(name: string, side: Side = "FEDERATION"): Player {
    const p = new Player(new NullSocket());
    p.settings.name = name;

    p.ship = new Ship(p);
    p.ship.name = name;
    p.ship.side = side;
    p.ship.energy = 5000;
    p.ship.damage = 0;
    p.ship.shieldsUp = true;
    p.ship.shieldEnergy = MAX_SHIELD_ENERGY; // start full
    p.ship.torpedoes = 10;
    p.ship.position = { v: 10, h: 10 };

    return p;
}

/** Create a starbase planet for a side, with full shields. */
export function makeBase(side: Extract<Side, "FEDERATION" | "EMPIRE">, v = 12, h = 10): Planet {
    const b = new Planet(v, h);
    b.isBase = true;
    b.side = side;
    b.energy = 1000; // base shields 0..1000
    b.builds = 0;
    return b;
}

/** Reset global game state touched by tests. */
export function resetGameState(): void {
    (players as Player[]).splice(0, players.length);
    bases.federation.splice(0, bases.federation.length);
    bases.empire.splice(0, bases.empire.length);

    settings.dotime = 0;
    if (typeof settings.stardate !== "number") settings.stardate = 0;
}

/* -------------------------- watchValues telemetry -------------------------- */

export type WatchSnapshot = Readonly<{
    label: string;
    before: Record<string, number>;
    after: Record<string, number>;
}>;

export type Watch = Readonly<{
    done: (label: string) => WatchSnapshot;
}>;

/** Track arbitrary numeric/boolean getters before/after. */
export function watchValues(probe: Record<string, () => number | boolean>): Watch {
    const toNum = (v: number | boolean) => (typeof v === "boolean" ? (v ? 1 : 0) : v);

    const before: Record<string, number> = {};
    for (const [k, getter] of Object.entries(probe)) before[k] = toNum(getter());

    return {
        done: (label: string) => {
            const after: Record<string, number> = {};
            for (const [k, getter] of Object.entries(probe)) after[k] = toNum(getter());
            return { label, before, after };
        },
    };
}

/* --------------------------- scoring trace helper -------------------------- */

export function makeScoringTrace(): {
    scoring: {
        dmgEnemiesCalls: [number, Player, Side][];
        dmgBasesCalls: [number, Player, Side][];
        killsCalls: [number, Player, Side][];
    };
    restore: () => void;
} {
    const pm = pointsManager as unknown as {
        addDamageToEnemies?: (amount: number, src: Player, side: Side) => void;
        addDamageToBases?: (amount: number, src: Player, side: Side) => void;
        addEnemiesDestroyed?: (count: number, src: Player, side: Side) => void;
    };

    const scoring = {
        dmgEnemiesCalls: [] as [number, Player, Side][],
        dmgBasesCalls: [] as [number, Player, Side][],
        killsCalls: [] as [number, Player, Side][],
    };

    const originals = {
        addDamageToEnemies: pm.addDamageToEnemies,
        addDamageToBases: pm.addDamageToBases,
        addEnemiesDestroyed: pm.addEnemiesDestroyed,
    };

    pm.addDamageToEnemies = (amount: number, src: Player, side: Side) => {
        scoring.dmgEnemiesCalls.push([amount, src, side]);
        originals.addDamageToEnemies?.call(pointsManager, amount, src, side);
    };

    pm.addDamageToBases = (amount: number, src: Player, side: Side) => {
        scoring.dmgBasesCalls.push([amount, src, side]);
        originals.addDamageToBases?.call(pointsManager, amount, src, side);
    };

    pm.addEnemiesDestroyed = (count: number, src: Player, side: Side) => {
        scoring.killsCalls.push([count, src, side]);
        originals.addEnemiesDestroyed?.call(pointsManager, count, src, side);
    };

    return {
        scoring,
        restore: () => {
            pm.addDamageToEnemies = originals.addDamageToEnemies;
            pm.addDamageToBases = originals.addDamageToBases;
            pm.addEnemiesDestroyed = originals.addEnemiesDestroyed;
        },
    };
}
// ---- Console helpers (env-gated) -------------------------------------------
export const TEST_LOG = process.env.TEST_LOG === "1";

export function logHeading(title: string) {
    if (!TEST_LOG) return;
    console.log("\n\u001b[36m=== " + title + " ===\u001b[0m");
}

export function logTable<T extends object>(title: string, rows: T[]) {
    if (!TEST_LOG) return;
    logHeading(title);
    console.table(rows);
}

export function dumpScoring(trace: {
    scoring: {
        dmgEnemiesCalls: [number, unknown, string][];
        dmgBasesCalls: [number, unknown, string][];
        killsCalls: [number, unknown, string][];
    };
}) {
    if (!TEST_LOG) return;
    logHeading("Scoring — damage to ENEMIES");
    console.table(
        trace.scoring.dmgEnemiesCalls.map((c, i) => ({
            i,
            points: c[0],
            bySide: c[2],
            playerName: (c[1] as any)?.settings?.name ?? "n/a",
        }))
    );
    logHeading("Scoring — damage to BASES");
    console.table(
        trace.scoring.dmgBasesCalls.map((c, i) => ({
            i,
            points: c[0],
            bySide: c[2],
            playerName: (c[1] as any)?.settings?.name ?? "n/a",
        }))
    );
    logHeading("Scoring — kills");
    console.table(
        trace.scoring.killsCalls.map((c, i) => ({
            i,
            count: c[0],
            bySide: c[2],
            playerName: (c[1] as any)?.settings?.name ?? "n/a",
        }))
    );
}
