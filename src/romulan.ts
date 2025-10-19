// romulan.ts — FORTRAN-parity Romulan (ROMDRV/ROMTOR/ROMSTR/PHAROM/TOROM/DEADRO)

import { ran, iran } from './util/random.js';
import { Player } from "./player.js";
import { NullSocket } from "./util/nullsocket.js";
import { GRID_HEIGHT, GRID_WIDTH, settings } from "./settings.js";
import { players, bases, stars, pointsManager } from "./game.js";
import { addPendingMessage } from "./communication.js";
import { queueCommands } from "./command.js";

// Switchable speech targeting policy (set default you believe matches FORTRAN)
type TauntPolicy = "NEAREST_ONLY" | "SINGLE_SHIP_OR_SIDE_OR_ALL" | "SIDE_PREFERENCE";
const ROMULAN_TAUNT_POLICY: TauntPolicy = "SINGLE_SHIP_OR_SIDE_OR_ALL";

function pickTellAudience(recipients: Player[]): { kind: "SHIP" | "SIDE" | "ALL"; value?: string } {
    // Defensive
    const r = recipients.filter(p => p.ship);
    if (r.length === 0) return { kind: "ALL" };

    switch (ROMULAN_TAUNT_POLICY) {
        case "NEAREST_ONLY": {
            // Always taunt the single nearest target ship (even if many are around)
            const nearest = r.reduce((best, p) => {
                const d = chebyshev(p.ship!.position, romulan!.ship!.position);
                return !best || d < best.d ? { p, d } : best;
            }, null as null | { p: Player; d: number });
            return { kind: "SHIP", value: nearest!.p.ship!.name };
        }
        case "SIDE_PREFERENCE": {
            // If any FEDs are present, taunt FED side; else if any EMPIRE present, taunt EMPIRE; else ALL
            const hasFed = r.some(p => p.ship!.side === "FEDERATION");
            const hasEmp = r.some(p => p.ship!.side === "EMPIRE");
            if (hasFed && !hasEmp) return { kind: "SIDE", value: "FEDERATION" };
            if (hasEmp && !hasFed) return { kind: "SIDE", value: "EMPIRE" };
            if (r.length === 1) return { kind: "SHIP", value: r[0].ship!.name };
            return { kind: "ALL" };
        }
        case "SINGLE_SHIP_OR_SIDE_OR_ALL":
        default: {
            if (r.length === 1) return { kind: "SHIP", value: r[0].ship!.name };
            const sides = new Set(r.map(p => p.ship!.side));
            if (sides.size === 1) return { kind: "SIDE", value: [...sides][0] };
            return { kind: "ALL" };
        }
    }
}
import { chebyshev, bresenhamLine, findEmptyLocation, findObjectAtPosition } from "./coords.js";
import { Planet } from "./planet.js";
import { applyPhaserDamage } from "./phaser.js";
import { torpedoDamage } from "./torpedo.js";
import { Ship } from "./ship.js";
import { Star } from "./star.js";
import { Blackhole } from "./blackhole.js";
import { triggerNovaAt } from "./nova.js";
import { emitNovaTriggered } from "./api/events.js";
import type { GridCoord } from "./api/events.js";


// ----- constants (FORTRAN-aligned) -----
const KRANGE = 10;                  // search/notify/attack window (FORTRAN krange=10)
const TORP_SHOTS = 3;               // ROMTOR loop id=1..3
const PHA_PHIT = 0.4;               // FORTRAN 200 -> 0.4 (removed 10x integer trick)
const PHA_BASE_PAUSE_MS = 750;      // (slwest+1)*750 in FORTRAN; we scale by active players
const TORP_BASE_PAUSE_MS = 1000;    // (slwest+1)*1000 in FORTRAN

// ----- small helpers -----
const activePlayersPlusOne = () =>
    Math.max(1, players.filter(p => p.ship && p.ship.energy > 0).length + 1);


type ScoringAPI = {
    incrementShipsCommissioned?(side: string): void;
    /**
     * FORTRAN parity: decrement star-destruction reserve when a Romulan torp
     * successfully detonates a star into a nova. Original does: rsr(KNSDES) -= 500
     */
    decrementStarDestruction?(amount: number): void;
};

// ----- Romulan singleton state -----
export let romulan: Player | null = null;
let erom = 0;                 // FORTRAN erom (Romulan “energy” tracked separately)
let romcnt = 0;               // FORTRAN romcnt (spawn cadence counter)
let rppausUntil = 0;          // phaser pause timestamp (ms)
let rtpausUntil = 0;          // torpedo pause timestamp (ms)

// ----- spawn cadence like ROMDRV -----
export function maybeSpawnRomulan(): void {
    if (!settings.generated) return;
    if (romulan && romulan.ship) return;

    romcnt += 1;

    const numply = Math.max(1, players.filter(p => p.ship && p.ship.energy > 0).length);

    // slow start: wait until roughly half a sweep has gone by
    if (romcnt * 2 < numply) return;

    // spawn only when enough cycles have passed AND a random gate opens
    if (romcnt >= numply * 3 && iran(5) === 5) {
        spawnRomulan();
        erom = iran(200) + 200; // 201..400

        // notify nearby players (iwhat=11 semantics simplified)
        if (romulan?.ship) {
            const rv = romulan.ship.position.v;
            const rh = romulan.ship.position.h;
            for (const p of players) {
                if (!p.ship) continue;
                if (chebyshev(p.ship.position, { v: rv, h: rh }) <= KRANGE) {
                    addPendingMessage(p, `Sensors: a Romulan vessel has appeared near ${rv}-${rh}!`);
                }
            }
        }
        romcnt = 0;
    }
}

// explicit spawn with placement
export function spawnRomulan(): void {
    if (romulan && romulan.ship) return;

    const pl = new Player(new NullSocket());
    pl.settings.name = "ROMULAN";
    if (pl.ship) {
        pl.ship.name = "ROMULAN";
        pl.ship.side = "ROMULAN";
        pl.ship.romulanStatus = { isRomulan: true, isRevealed: false, cloaked: true };
        pl.ship.energy = 0;          // not used for durability (we use erom)
        pl.ship.damage = 0;
        pl.ship.shieldEnergy = 0;

        const pos = findEmptyLocation();
        if (pos) {
            pl.ship.position = pos;
            players.push(pl);

            // optional scoring hook (no `any`)
            (pointsManager as unknown as ScoringAPI).incrementShipsCommissioned?.("ROMULAN");

            romulan = pl;
        }
    }
}

// ----- main per-tick update (ROMDRV core) -----
export function updateRomulan(): void {
    if (!romulan?.ship) return;

    // occasional speech
    if (iran(10) === 1) romulanSpeaks();

    // find nearest ship/base in range
    const target = findClosestTargetInRange();
    if (!target) return;

    // choose weapon by cooldowns (FORTRAN style)
    const now = Date.now();
    const phaReady = now >= rppausUntil;
    const torpReady = now >= rtpausUntil;

    if (!phaReady && !torpReady) {
        romulanApproachTick(); // close the gap while waiting to fire
        return;
    }

    romcnt = 0; // reset cadence when firing

    if (phaReady && torpReady) {
        if (iran(2) === 1) fireRomulanTorpedoes(target);
        else fireRomulanPhasers(target);
    } else if (phaReady) {
        fireRomulanPhasers(target);
    } else {
        fireRomulanTorpedoes(target);
    }
}

// ----- target selection like ROMDRV: ships first, then bases, within KRANGE -----
type Target =
    | { kind: "ship"; player: Player; distance: number }
    | { kind: "base"; planet: Planet; distance: number };

function findClosestTargetInRange(): Target | null {
    if (!romulan?.ship) return null;
    const rpos = romulan.ship.position;

    let best: Target | null = null;

    // enemy ships (FED/EMP)
    for (const p of players) {
        if (!p.ship) continue;
        if (p === romulan) continue;
        if (p.ship.side !== "FEDERATION" && p.ship.side !== "EMPIRE") continue;
        const d = chebyshev(p.ship.position, rpos);
        if (d > KRANGE) continue;
        if (!best || d < best.distance) best = { kind: "ship", player: p, distance: d };
    }

    // enemy bases
    for (const side of ["FEDERATION", "EMPIRE"] as const) {
        const list = side === "FEDERATION" ? bases.federation : bases.empire;
        for (const base of list) {
            const d = chebyshev(base.position, rpos);
            if (d > KRANGE) continue;
            if (!best || d < best.distance) best = { kind: "base", planet: base, distance: d };
        }
    }

    return best;
}

// ----- phaser path (PHADAM parity via applyPhaserDamage) -----
function fireRomulanPhasers(target: Target): void {
    if (!romulan?.ship) return;

    // base “calls for help” when first hit at full shields
    if (target.kind === "base" && target.planet.energy === 1000) {
        for (const p of players) {
            if (!p.ship) continue;
            if (p.ship.side === target.planet.side) {
                addPendingMessage(
                    p,
                    `Starbase ${target.planet.position.v}-${target.planet.position.h} is under Romulan phaser fire!`
                );
            }
        }
    }

    // Snapshot pre-state for ships so we can message correctly post-resolution.
    let preShieldsUp = false;
    let preShieldEnergy = 0;
    if (target.kind === "ship" && target.player.ship) {
        preShieldsUp = Boolean(target.player.ship.shieldsUp);
        preShieldEnergy = target.player.ship.shieldEnergy;
    }

    // fire (let phaser core handle distance/absorption)
    const res = applyPhaserDamage(
        romulan,
        target.kind === "ship" ? target.player : target.planet,
        PHA_PHIT
    );

    // message victim (distinguish true absorption from no-effect/miss)
    if (target.kind === "ship") {
        const dealt = Math.round(res.hita || 0);
        const postShieldEnergy = target.player.ship ? target.player.ship.shieldEnergy : 0;
        const absorbed =
            dealt === 0 &&
            preShieldsUp === true &&
            postShieldEnergy < preShieldEnergy; // drain actually happened

        if (dealt > 0) {
            addPendingMessage(target.player, `Romulan phasers hit you for ${dealt}!`);
        } else if (absorbed) {
            addPendingMessage(target.player, `Your shields absorbed the Romulan phasers.`);
        } else {
            addPendingMessage(target.player, `Romulan phasers had no effect.`);
        }

        // Optional debug to trace odd reports from the field
        console.log(
            `[ROM-PH] dealt=${dealt} preUp=${preShieldsUp} preSE=${preShieldEnergy} postSE=${postShieldEnergy}`
        );
    }

    const pause = PHA_BASE_PAUSE_MS * activePlayersPlusOne();
    rppausUntil = Date.now() + pause;
}

// ----- torpedo path (ROMSTR + ROMTOR parity) -----
function fireRomulanTorpedoes(target: Target): void {
    if (!romulan?.ship) return;

    // initial aim point
    let aim =
        target.kind === "ship" ? (target.player.ship ? target.player.ship.position : null) : target.planet.position;
    if (!aim) return;

    // ROMSTR: retarget to adjacent star if present
    aim = retargetToAdjacentStar(aim) ?? aim;

    // ROMTOR: 3 shots with reacquire + star retarget each time
    for (let shot = 1; shot <= TORP_SHOTS; shot += 1) {
        if (!aim) break;

        // --- FORTRAN-ish line-of-flight with small scatter/misfire ---
        // Add a tiny jitter to emulate ROMTOR's deflection/misfire feel
        const jv = (ran() - 0.5) < 0 ? 0 : 1; // ~50% nudge one step on v
        const jh = (ran() - 0.5) < 0 ? 0 : 1; // ~50% nudge one step on h
        const jittered = { v: Math.max(1, Math.min(GRID_HEIGHT, aim.v + jv)), h: Math.max(1, Math.min(GRID_WIDTH, aim.h + jh)) };

        const rpos = romulan.ship.position;
        let hit: { v: number; h: number } | null = null;
        let obj: unknown = null;
        for (const p of bresenhamLine(rpos.v, rpos.h, jittered.v, jittered.h)) {
            if (p.v === rpos.v && p.h === rpos.h) continue;
            const found = findObjectAtPosition(p.v, p.h);
            if (found?.obj) {
                hit = p;
                obj = found.obj;
                break;
            }
        }
        // If nothing in the way, treat as a harmless boundary fizzle
        if (!obj) {
            // small miss message to help field-debug "random novas"
            addPendingMessage(romulan, `Romulan torpedo missed (no obstruction in flight).`);
        }

        if (obj instanceof Star) {
            // FORTRAN ROMTOR parity:
            // If a star is hit, 80% chance to cause a nova centered on that star,
            // crediting the Romulan as the attacker. (snova + notifications)
            if (iran(100) < 80) {
                // emit event first so loggers/clients see the cause
                const at: GridCoord = { v: hit?.v ?? aim.v, h: hit?.h ?? aim.h };
                emitNovaTriggered(at, romulan);
                // run nova resolution (damage, displacement, star removal, chain reactions)
                triggerNovaAt(romulan, at.v, at.h);
            } else {
                // no nova: still give a small flavor message like the original did sometimes
                const vv = hit?.v ?? aim.v, hh = hit?.h ?? aim.h;
                addPendingMessage(romulan, `Romulan torpedo fizzles near the star at ${vv}-${hh}.`);
            }
        } else if (obj instanceof Planet) {
            if (obj.isBase) {
                // FORTRAN ROMTOR parity:
                // If the base is at full shields (1000), broadcast a distress call
                if (obj.energy === 1000) {
                    for (const p of players) {
                        if (!p.ship) continue;
                        if (p.ship.side === obj.side) {
                            addPendingMessage(
                                p,
                                `Starbase ${obj.position.v}-${obj.position.h} is under Romulan torpedo fire!`
                            );
                        }
                    }
                }
                torpedoDamage(romulan, obj);
            } else {
                // accidental planet attack: 25% chance to reduce builds by 1
                if (iran(100) >= 75) obj.builds = Math.max(0, obj.builds - 1);
            }
        } else if (obj instanceof Ship) {
            const targetPlayer =
                players.find(p => p.ship === obj) ||
                players.find(p => p.ship && p.ship.position.v === aim!.v && p.ship.position.h === aim!.h);
            if (targetPlayer) torpedoDamage(romulan, targetPlayer);
        } else if (obj instanceof Blackhole) {
            addPendingMessage(romulan, `Romulan torpedo lost in a black hole near ${aim.v}-${aim.h}.`);
        }

        // reacquire nearest, then ROMSTR star retarget again
        const nxt = findClosestTargetInRange();
        if (!nxt) break;

        let nextPos: { v: number; h: number } | null = null;
        if (nxt.kind === "ship" && nxt.player.ship) nextPos = nxt.player.ship.position;
        if (nxt.kind === "base") nextPos = nxt.planet.position;
        if (!nextPos) break;

        aim = retargetToAdjacentStar(nextPos) ?? nextPos;
        // --- per-shot cooldown accumulation like FORTRAN ---
        const perShotPause = TORP_BASE_PAUSE_MS * activePlayersPlusOne();
        rtpausUntil = Math.max(rtpausUntil, Date.now()) + perShotPause;
    }
    // (No extra lump-sum pause; already accumulated per shot)
}

// ROMSTR: if a star is adjacent to aim, retarget to it
function retargetToAdjacentStar(pos: { v: number; h: number }): { v: number; h: number } | null {
    const vf = Math.max(1, pos.v - 1);
    const vl = Math.min(GRID_HEIGHT, pos.v + 1);
    const hf = Math.max(1, pos.h - 1);
    const hl = Math.min(GRID_WIDTH, pos.h + 1);

    for (let v = vf; v <= vl; v += 1) {
        for (let h = hf; h <= hl; h += 1) {
            if (stars.some(s => s.position.v === v && s.position.h === h)) return { v, h };
        }
    }
    return null;
}

// ----- movement helper (safe approach) -----
function moveToward(targetPos: { v: number; h: number }): void {
    if (!romulan?.ship) return;
    const rpos = romulan.ship.position;

    const dv = targetPos.v - rpos.v;
    const dh = targetPos.h - rpos.h;
    const dist = Math.max(Math.abs(dv), Math.abs(dh));

    // up to 4 steps, but don’t enter the target tile
    const steps = Math.max(1, Math.min(4, dist));
    const sv = Math.sign(dv);
    const sh = Math.sign(dh);

    let nv = rpos.v + sv * Math.max(0, steps - 1);
    let nh = rpos.h + sh * Math.max(0, steps - 1);

    // clamp to bounds
    nv = Math.max(1, Math.min(GRID_HEIGHT, nv));
    nh = Math.max(1, Math.min(GRID_WIDTH, nh));

    // simple path clearance
    const path = [...bresenhamLine(rpos.v, rpos.h, nv, nh)];
    path.shift(); // skip start
    let blocked = false;
    for (const p of path) {
        if (findObjectAtPosition(p.v, p.h)) {
            blocked = true;
            break;
        }
    }
    if (blocked) {
        nv = rpos.v + sv * Math.max(0, steps - 2);
        nh = rpos.h + sh * Math.max(0, steps - 2);
    }

    if (!findObjectAtPosition(nv, nh)) {
        romulan.ship.position = { v: nv, h: nh };
    }
}

// optional: call between attacks if you want the Romulan to “close distance”
export function romulanApproachTick(): void {
    const target = findClosestTargetInRange();
    if (!target) return;
    const tpos =
        target.kind === "ship" && target.player.ship
            ? target.player.ship.position
            : target.kind === "base"
                ? target.planet.position
                : null;
    if (tpos) moveToward(tpos);
}

// ----- “Romulan gets hit by …” (PHAROM/TOROM) -----
// id = distance in original (used in divisor)
export function applyRomulanPhaserHitFrom(
    phit: number,
    id: number
): { ihita: number; killed: boolean } {
    if (!romulan) return { ihita: 0, killed: false };

    // ihita = ((100 + iran(100)) * phit) / (10 * id)
    const denom = 10 * Math.max(1, id);
    const ihita = ((100 + iran(100)) * phit) / denom;

    // erom = erom - (ihita / 10)
    erom -= ihita / 10;

    if (erom <= 0) {
        destroyRomulan();
        return { ihita, killed: true };
    }
    return { ihita, killed: false };
}

export function applyRomulanTorpedoHitFrom(): { ihita: number; killed: boolean } {
    if (!romulan) return { ihita: 0, killed: false };

    // ihita = min(iran(4000), 2000)
    const ihita = Math.min(iran(4000), 2000);

    // erom = erom - (ihita / 10)
    erom -= ihita / 10;

    if (erom <= 0) {
        destroyRomulan();
        return { ihita, killed: true };
    }
    return { ihita, killed: false };
}

// ----- DEADRO parity -----
export function destroyRomulan(): void {
    if (!romulan?.ship) {
        romulan = null;
        return;
    }

    romulan.ship.romulanStatus.cloaked = true;

    const idx = players.indexOf(romulan);
    if (idx !== -1) players.splice(idx, 1);

    romulan = null;
    erom = 0;
    rppausUntil = 0;
    rtpausUntil = 0;
}

// ----- flavor (speech) -----
function romulanSpeaks(): void {
    if (!romulan?.ship) return;
    const rh = romulan.ship.position.h;
    const rv = romulan.ship.position.v;
    const recipients = players.filter(
        p => p !== romulan && p.ship && chebyshev(p.ship.position, { v: rv, h: rh }) <= KRANGE
    );
    if (recipients.length === 0) return;
    const audience = pickTellAudience(recipients);
    const single = audience.kind === "SHIP"; // controls singular/plural phrasing
    const msg = generateRomulanMessage(single);
    if (audience.kind === "SHIP") {
        queueCommands(romulan, `TELL ${audience.value}; ${msg}`);
    } else if (audience.kind === "SIDE") {
        queueCommands(romulan, `TELL ${audience.value}; ${msg}`);
    } else {
        queueCommands(romulan, `TELL ALL; ${msg}`);
    }
}

function generateRomulanMessage(single: boolean): string {
    const lead = single
        ? [
            "You have aroused my wrath, ",
            "You will witness my vengeance, ",
            "May you be attacked by a slime-devil, ",
            "I will reduce you to quarks, ",
        ]
        : ["Death to ", "Destruction to ", "I will crush ", "Prepare to die, "];

    const adjectives = ["mindless ", "worthless ", "ignorant ", "idiotic ", "stupid "];
    const species = ["sub-Romulan ", "human ", "klingon "];
    const objects = ["mutant", "cretin", "toad", "worm", "parasite"];

    const l = lead[iran(lead.length)];
    const a = adjectives[iran(adjectives.length)];
    const s = single ? "" : species[iran(species.length)];
    const o = objects[iran(objects.length)];

    return `${l}${a}${s}${o}${single ? "!" : "s!"}`;
}



