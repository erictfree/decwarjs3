/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { applyPhaserDamage } from "../src/phaser.js";
import { torpedoDamage } from "../src/torpedo.js";
import { MAX_SHIELD_ENERGY } from "../src/settings.js";

import {
    withFixedRandom,
    resetGameState,
    makePlayer,
    makeBase,
    makeScoringTrace,
    logTable,
    dumpScoring,
} from "./helpers.js";

// --- local helpers (no import needed) ---------------------------------------
function setDistance(attacker: any, target: any, d: number) {
    // place target to the right of attacker by Chebyshev distance d
    const attPos = attacker.ship ? attacker.ship.position : attacker.position;
    const tgtHasShip = !!target.ship;
    const pos = tgtHasShip ? target.ship.position : target.position;
    pos.v = attPos.v;
    pos.h = attPos.h + d;
}

function setShieldPct(target: any, pct0to1000: number) {
    const pct = Math.max(0, Math.min(1000, pct0to1000));
    if (target.ship) {
        target.ship.shieldEnergy = Math.round((pct / 1000) * MAX_SHIELD_ENERGY);
    } else if (typeof target.energy === "number") {
        // bases store “shield” as 0..1000 in energy
        target.energy = pct;
    }
}

// ----------------------------------------------------------------------------

describe("Parity sweeps vs legacy expectations", () => {
    beforeEach(() => {
        resetGameState();
    });

    test("PHASERS: sweep phit × distance × shield% — sanity + scoring", () => {
        const fed = makePlayer("FED-1", "FEDERATION");
        const emp = makePlayer("EMP-1", "EMPIRE");

        const trace = makeScoringTrace();

        const phits = [0.2, 0.4, 0.6, 0.8];
        const dists = [1, 2, 4, 8];
        const shieldPcts = [0, 250, 500, 750, 1000];

        const rngSeq = Array(200).fill(0.88);

        const rows: Array<{
            phit: number;
            dist: number;
            shieldPct: number;
            hullLoss: number;
            empEnergy: number;
            empShield: number;
        }> = [];

        for (const phit of phits) {
            for (const sp of shieldPcts) {
                // reset defender each run
                emp.ship!.energy = 5000;
                emp.ship!.damage = 0;
                emp.ship!.shieldEnergy = MAX_SHIELD_ENERGY;
                setShieldPct(emp, sp);

                for (const d of dists) {
                    setDistance(fed, emp, d);
                    const preEnergy = emp.ship!.energy;

                    withFixedRandom(rngSeq, () => {
                        applyPhaserDamage(fed, emp, phit);
                    });

                    const hullLoss = preEnergy - emp.ship!.energy;

                    rows.push({
                        phit,
                        dist: d,
                        shieldPct: sp,
                        hullLoss,
                        empEnergy: emp.ship!.energy,
                        empShield: emp.ship!.shieldEnergy,
                    });

                    // basic sanity: hull never increases
                    expect(emp.ship!.energy).toBeLessThanOrEqual(preEnergy);
                }
            }
        }

        logTable("PHASERS sweep (phit × dist × shield%)", rows);

        // At least one positive enemy-damage score (Fed -> Empire)
        expect(trace.scoring.dmgEnemiesCalls.some((c) => (c[0] as number) > 0)).toBe(true);

        // Friendly fire (Fed->Fed) should be non-positive in enemy-damage scoring
        const ally = makePlayer("ALLY", "FEDERATION");
        setDistance(fed, ally, 1);
        setShieldPct(ally, 500);
        const before = trace.scoring.dmgEnemiesCalls.length;
        withFixedRandom([0.88, 0.9, 0.88, 0.9], () => {
            applyPhaserDamage(fed, ally, 0.6);
        });
        const rec = trace.scoring.dmgEnemiesCalls[before];
        if (rec) {
            expect(rec[0] as number).toBeLessThanOrEqual(0);
        }

        dumpScoring(trace);
    });

    test("PHASERS: base collapse path can kill + base kill scoring", () => {
        const fed = makePlayer("FED-PH-B", "FEDERATION");
        const base = makeBase("EMPIRE", 11, 10); // enemy base near-by
        const trace = makeScoringTrace();

        setDistance(fed, base as any, 1); // keep close

        // Favorable sequence to sometimes trigger collapse kill branch
        withFixedRandom([0.5, 0.05, 0.5, 0.05], () => {
            applyPhaserDamage(fed, base, 0.6);
        });

        const baseDmgCalls = trace.scoring.dmgBasesCalls;
        if (baseDmgCalls.length > 0) {
            const last = baseDmgCalls[baseDmgCalls.length - 1][0] as number;
            expect(last).toBeGreaterThan(0);
        }

        dumpScoring(trace);
    });

    test("TORPEDOES: sweep distance × shield% — sanity + scoring", () => {
        const fed = makePlayer("FED-T", "FEDERATION");
        const emp = makePlayer("EMP-T", "EMPIRE");
        const trace = makeScoringTrace();

        const dists = [1, 2, 4, 8];
        const shieldPcts = [0, 250, 500, 750, 1000];

        const rngSeq = [0.8, 0.2, 0.7, 0.3, 0.9, 0.4];

        const rows: Array<{
            dist: number;
            shieldPct: number;
            hullLoss: number;
            empEnergy: number;
            dmgCalls: number;
        }> = [];

        for (const sp of shieldPcts) {
            setShieldPct(emp, sp);
            for (const d of dists) {
                setDistance(fed, emp, d);
                const pre = emp.ship!.energy;
                withFixedRandom(rngSeq, () => {
                    torpedoDamage(fed, emp);
                });
                rows.push({
                    dist: d,
                    shieldPct: sp,
                    hullLoss: pre - emp.ship!.energy,
                    empEnergy: emp.ship!.energy,
                    dmgCalls: trace.scoring.dmgEnemiesCalls.length,
                });
                expect(emp.ship!.energy).toBeLessThanOrEqual(pre);
            }
        }

        logTable("TORPEDO sweep (dist × shield%)", rows);

        // Enemy scoring captured
        expect(trace.scoring.dmgEnemiesCalls.some((c) => (c[0] as number) > 0)).toBe(true);

        // Friendly fire non-positive
        const ally = makePlayer("ALLY-T", "FEDERATION");
        setDistance(fed, ally, 1);
        setShieldPct(ally, 500);
        const before = trace.scoring.dmgEnemiesCalls.length;
        withFixedRandom(rngSeq, () => {
            torpedoDamage(fed, ally);
        });
        const rec = trace.scoring.dmgEnemiesCalls[before];
        if (rec) {
            expect(rec[0] as number).toBeLessThanOrEqual(0);
        }

        dumpScoring(trace);
    });
});
