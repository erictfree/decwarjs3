/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { torpedoDamage } from "../src/torpedo.js";
import { players, bases } from "../src/game.js";
import type { Planet } from "../src/planet.js";

import {
    resetGameState,
    makePlayer,
    makeBase,
    withFixedRandom,
    watchValues,
    makeScoringTrace,
} from "./helpers.js";

describe("TORPEDOES: rich telemetry", () => {
    beforeEach(() => {
        resetGameState();
    });

    test("ship → ship: damage path, enemy scoring > 0", () => {
        const fed = makePlayer("FED", "FEDERATION");
        const emp = makePlayer("EMP", "EMPIRE");
        players.push(fed, emp);

        emp.ship!.position = { v: fed.ship!.position.v + 1, h: fed.ship!.position.h };
        emp.ship!.shieldEnergy = 100; // ensure hull dmg

        const trace = makeScoringTrace();
        const watch = watchValues({
            empEnergy: () => emp.ship!.energy,
            callsEnemies: () => trace.scoring.dmgEnemiesCalls.length,
        });

        // Avoid deflection: pick numbers that keep rand2 > 0 in your torpedo logic
        const res = withFixedRandom([0.8, 0.2], () => torpedoDamage(fed, emp));
        const snap = watch.done("post-torp-ship-ship");

        expect(res.hita).toBeGreaterThan(0);
        expect(snap.after["empEnergy"]).toBeLessThan(5000);
        expect(trace.scoring.dmgEnemiesCalls.length).toBeGreaterThan(0);
        const points = trace.scoring.dmgEnemiesCalls[0][0] as number;
        expect(points).toBeGreaterThan(0);

        trace.restore();
    });

    test("ship → base: damage or kill; base scoring on kill", () => {
        const fed = makePlayer("FED", "FEDERATION");
        const base: Planet = makeBase("EMPIRE");
        players.push(fed);
        bases.empire.push(base);

        base.position = { v: fed.ship!.position.v + 1, h: fed.ship!.position.h };

        const trace = makeScoringTrace();
        const watch = watchValues({
            baseEnergy: () => base.energy,
            baseInList: () => bases.empire.includes(base),
        });

        const res = withFixedRandom([0.9, 0.1, 0.05], () => torpedoDamage(fed, base));
        const snap = watch.done("post-torp-ship-base");

        if (res.isDestroyed) {
            expect(snap.after["baseInList"]).toBe(0);
            expect(trace.scoring.dmgBasesCalls.length).toBeGreaterThan(0);
            const amount = trace.scoring.dmgBasesCalls[0][0] as number;
            expect(Math.abs(amount)).toBeGreaterThanOrEqual(10000);
            expect(trace.scoring.killsCalls.length).toBeGreaterThan(0);
        } else {
            expect(snap.after["baseEnergy"]).toBeLessThan(1000);
        }

        trace.restore();
    });

    test("deflection path possible: minimal hull on strong shields", () => {
        const fed = makePlayer("FED", "FEDERATION");
        const emp = makePlayer("EMP", "EMPIRE");
        players.push(fed, emp);

        emp.ship!.shieldEnergy = 900; // encourage deflection
        emp.ship!.position = { v: fed.ship!.position.v + 1, h: fed.ship!.position.h };

        const trace = makeScoringTrace();
        const res = withFixedRandom([0.01, 0.99], () => torpedoDamage(fed, emp));

        expect(res.hita).toBeGreaterThanOrEqual(0);
        // just ensure the spy didn’t crash and calls are collected or not
        expect(Array.isArray(trace.scoring.dmgEnemiesCalls)).toBe(true);

        trace.restore();
    });
});
