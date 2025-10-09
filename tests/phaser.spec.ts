/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { applyPhaserDamage } from "../src/phaser.js";
import { MAX_SHIELD_ENERGY } from "../src/settings.js";
import { players, bases, SHIP_FATAL_DAMAGE } from "../src/game.js";
import type { Planet } from "../src/planet.js";

import {
    resetGameState,
    makePlayer,
    makeBase,
    withFixedRandom,
    watchValues,
    makeScoringTrace,
} from "./helpers.js";

describe("PHASERS: rich telemetry", () => {
    beforeEach(() => {
        resetGameState();
    });

    test("ship → ship: shield drain, hull damage, scoring", () => {
        const fed = makePlayer("FED", "FEDERATION");
        const emp = makePlayer("EMP", "EMPIRE");
        players.push(fed, emp);

        emp.ship!.position = { v: fed.ship!.position.v + 1, h: fed.ship!.position.h };
        // Ensure some hull damage by reducing shields
        emp.ship!.shieldEnergy = 100;

        const trace = makeScoringTrace();
        const watch = watchValues({
            empEnergy: () => emp.ship!.energy,
            empShield: () => emp.ship!.shieldEnergy,
            callsEnemies: () => trace.scoring.dmgEnemiesCalls.length,
        });

        const res = withFixedRandom([0.2, 0.9], () => applyPhaserDamage(fed, emp, 0.6));
        const snap = watch.done("post-phaser-ship-ship");

        expect(res.hita).toBeGreaterThan(0);
        expect(snap.after["empEnergy"]).toBeLessThan(5000);
        expect(snap.after["empShield"]).toBeLessThan(MAX_SHIELD_ENERGY);

        expect(trace.scoring.dmgEnemiesCalls.length).toBeGreaterThan(0);
        const points = trace.scoring.dmgEnemiesCalls[0][0] as number;
        expect(points).toBeGreaterThan(0);

        trace.restore();
    });

    test("ship → base: collapse path can outright kill + scoring", () => {
        const fed = makePlayer("FED", "FEDERATION");
        const base = makeBase("EMPIRE");
        players.push(fed);
        bases.empire.push(base);

        base.position = { v: fed.ship!.position.v + 1, h: fed.ship!.position.h };

        const trace = makeScoringTrace();
        const watch = watchValues({
            baseEnergy: () => base.energy,
            baseInList: () => bases.empire.includes(base),
        });

        const res = withFixedRandom([0.5, 0.05], () => applyPhaserDamage(fed, base, 0.4));
        const snap = watch.done("post-phaser-ship-base");

        if (res.klflg === 1) {
            expect(snap.after["baseInList"]).toBe(0);
            expect(trace.scoring.dmgBasesCalls.length).toBeGreaterThan(0);
            const amount = trace.scoring.dmgBasesCalls[0][0] as number;
            expect(Math.abs(amount)).toBeGreaterThanOrEqual(10000);
        } else {
            expect(snap.after["baseEnergy"]).toBeLessThan(1000);
        }

        trace.restore();
    });

    test("near-death defender dies once; kill counted once", () => {
        const fed = makePlayer("FED", "FEDERATION");
        const emp = makePlayer("EMP", "EMPIRE");
        players.push(fed, emp);

        emp.ship!.energy = 10;
        emp.ship!.damage = SHIP_FATAL_DAMAGE - 1;
        emp.ship!.shieldEnergy = 0; // ensure hull hit registers
        emp.ship!.position = { v: fed.ship!.position.v + 1, h: fed.ship!.position.h };

        const trace = makeScoringTrace();

        withFixedRandom([0.9, 0.9], () => {
            const res = applyPhaserDamage(fed, emp, 0.6);
            expect(res.hita).toBeGreaterThan(0);

            const kills = trace.scoring.killsCalls.filter((c: [number, unknown, string]) => {
                return c[0] === 1 && c[1] === fed && c[2] === "FEDERATION";
            });
            expect(kills.length).toBe(1);
        });

        trace.restore();
    });

    test("ship → planet (non-base): may reduce builds; no ship/base scoring", () => {
        const fed = makePlayer("FED", "FEDERATION");
        players.push(fed);

        const pl: Planet = makeBase("FEDERATION");
        pl.isBase = false;
        pl.side = "NEUTRAL";
        pl.builds = 3;
        pl.energy = 400;

        const trace = makeScoringTrace();
        const watch = watchValues({
            builds: () => pl.builds,
        });

        withFixedRandom([0.0], () => {
            const res = applyPhaserDamage(fed, pl, 0.4);
            expect(res.hita).toBeGreaterThanOrEqual(0);
        });

        const snap = watch.done("post-phaser-planet");
        expect(snap.after["builds"]).toBeLessThan(3);
        expect(trace.scoring.dmgEnemiesCalls.length).toBe(0);
        expect(trace.scoring.dmgBasesCalls.length).toBe(0);
        expect(trace.scoring.killsCalls.length).toBe(0);

        trace.restore();
    });
});
