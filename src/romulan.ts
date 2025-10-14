// romulan.ts — FORTRAN-parity Romulan (ROMDRV/ROMTOR/ROMSTR/PHAROM/TOROM/DEADRO)

import { Player } from "./player.js";
import { NullSocket } from "./util/nullsocket.js";
import { GRID_HEIGHT, GRID_WIDTH, settings } from "./settings.js";
import { players, bases, stars, pointsManager } from "./game.js";
import { addPendingMessage } from "./communication.js";
import { chebyshev, bresenhamLine, findEmptyLocation, findObjectAtPosition } from "./coords.js";
import { Planet } from "./planet.js";
import { applyPhaserDamage } from "./phaser.js";
import { torpedoDamage } from "./torpedo.js";
import { Ship } from "./ship.js";
import { Star } from "./star.js";
import { Blackhole } from "./blackhole.js";

// ----- constants (FORTRAN-aligned) -----
const KRANGE = 20;                  // search/notify/attack window
const TORP_SHOTS = 3;               // ROMTOR loop id=1..3
const PHA_PHIT = 0.4;               // FORTRAN 200 -> 0.4 (removed 10x integer trick)
const PHA_BASE_PAUSE_MS = 750;      // (slwest+1)*750 in FORTRAN; we scale by active players
const TORP_BASE_PAUSE_MS = 1000;    // (slwest+1)*1000 in FORTRAN

// ----- small helpers -----
const activePlayersPlusOne = () =>
    Math.max(1, players.filter(p => p.ship && p.ship.energy > 0).length + 1);

function iran(n: number): number {
    // 1..n inclusive (FORTRAN-like)
    return Math.floor(Math.random() * n) + 1;
}

type ScoringAPI = {
    incrementShipsCommissioned?(side: string): void;
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

    // fire (let phaser core handle distance/absorption)
    const res = applyPhaserDamage(
        romulan,
        target.kind === "ship" ? target.player : target.planet,
        PHA_PHIT
    );

    // message victim
    if (target.kind === "ship") {
        addPendingMessage(target.player, `Romulan phasers hit you for ${Math.round(res.hita)}!`);
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

        const found = findObjectAtPosition(aim.v, aim.h);
        const obj = found?.obj;

        if (obj instanceof Star) {
            // Star detonation messaging (nova behavior handled elsewhere in your engine if applicable)
            if (iran(100) <= 80) {
                addPendingMessage(romulan, `Romulan torpedo detonated near a star at ${aim.v}-${aim.h}.`);
            }
        } else if (obj instanceof Planet) {
            if (obj.isBase) {
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
    }

    // cooldown: tpaus = now + (active+1)*1000
    const pause = TORP_BASE_PAUSE_MS * activePlayersPlusOne();
    rtpausUntil = Date.now() + pause;
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

    const singleTarget = recipients.length === 1;
    const msg = generateRomulanMessage(singleTarget);

    for (const p of recipients) {
        addPendingMessage(p, `Romulan: ${msg}`);
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

    const l = lead[Math.floor(Math.random() * lead.length)];
    const a = adjectives[Math.floor(Math.random() * adjectives.length)];
    const s = single ? "" : species[Math.floor(Math.random() * species.length)];
    const o = objects[Math.floor(Math.random() * objects.length)];

    return `${l}${a}${s}${o}${single ? "!" : "s!"}`;
}






// // Romulan AI Canonical Implementation (State Machine + Fortran Fidelity)

// import { Player } from './player.js';
// import { applyDamage } from './torpedo.js';
// import { NullSocket } from './util/nullsocket.js';
// import {
//     GRID_WIDTH,
//     GRID_HEIGHT,
//     settings,
//     MAX_SHIELD_ENERGY,
// } from './settings.js';
// import {
//     players,
//     bases,
//     stars,
//     planets,
//     pointsManager,
// } from './game.js';
// import { addPendingMessage, sendMessageToClient } from './communication.js';
// import { torpedoDamage } from './torpedo.js';
// import { bresenhamLine, chebyshev, findEmptyLocation, findObjectAtPosition } from './coords.js';
// import { Planet } from './planet.js';

// // parity helpers
// import { phadamCore, applyShipCriticalParity } from './phaser.js';
// // If you already export this from a central crit module, import from there instead
// const CRIT_CHANCE = 0.20;

// const TARGET_RANGE = 20;
// const ATTACK_CHANCE = 1 / 3;
// let romulanCounter = 0;
// export let romulan: Player | null = null;

// enum RomulanState {
//     IDLE,
//     SPEAK,
//     SEARCH,
//     MOVE,
//     DECLOAK,
//     PREATTACK,
//     ATTACK,
//     REPAIR,
//     END
// }

// let romulanState = RomulanState.IDLE;

// let romulanTarget: Target | null = null;

// type Target = Planet | Player;

// export function maybeSpawnRomulan(): void {
//     if (!settings.generated) return;
//     romulanCounter++;
//     const numPlayers = players.length;

//     if ((!romulan || !romulan.ship) && romulanCounter >= numPlayers * 3 && Math.floor(Math.random() * 5) === 4) {
//         spawnRomulan();
//         romulanCounter = 0;
//     }
// }

// export function spawnRomulan(): void {
//     if (romulan && romulan.ship) return;

//     pointsManager.incrementShipsCommissioned('ROMULAN');

//     romulan = new Player(new NullSocket());
//     romulan.settings.name = 'ROMULAN';
//     if (romulan.ship) {
//         romulan.ship.name = 'ROMULAN';
//         romulan.ship.side = 'ROMULAN';
//         romulan.ship.romulanStatus = { isRomulan: true, isRevealed: false, cloaked: true };
//         romulan.ship.energy = 5000;
//         romulan.ship.damage = 0;
//         romulan.ship.shieldEnergy = 0;

//         const position = findEmptyLocation();
//         if (position) {
//             romulan.ship.position = position;
//             players.push(romulan);
//         }
//     }
// }

// export function updateRomulan(): void {
//     if (!romulan || !romulan.ship) return;

//     switch (romulanState) {
//         case RomulanState.IDLE:
//             romulanState = RomulanState.SPEAK;
//             break;

//         case RomulanState.SPEAK:
//             if (Math.random() < 1 / 10) romulanSpeaks();
//             romulanState = RomulanState.SEARCH;
//             break;

//         case RomulanState.SEARCH:
//             romulanTarget = findClosestTarget();
//             if (romulanTarget) {
//                 romulanState = RomulanState.MOVE;
//             } else {
//                 relocateRomulan();
//                 romulanState = RomulanState.END;
//             }
//             break;

//         case RomulanState.MOVE: {
//             if (!romulanTarget) {
//                 romulanState = RomulanState.END;
//                 break;
//             }

//             const destination = romulanTarget instanceof Player
//                 ? romulanTarget.ship?.position
//                 : romulanTarget.position;

//             if (!destination) {
//                 romulanState = RomulanState.END;
//                 break;
//             }

//             if (romulan && romulan.ship && !isPathClear(romulan.ship.position, destination)) {
//                 romulanState = RomulanState.END;
//                 break;
//             }

//             romulan.ship.position = computeRomulanMovement(romulan.ship.position, destination);
//             romulanState = RomulanState.DECLOAK;
//             romulan.ship.romulanStatus.cloaked = false;
//             break;
//         }

//         case RomulanState.DECLOAK:
//             romulanState = RomulanState.PREATTACK;
//             break;

//         case RomulanState.PREATTACK:
//             romulanState = RomulanState.ATTACK;
//             break;

//         case RomulanState.ATTACK: {
//             if (!romulanTarget) {
//                 romulanState = RomulanState.END;
//                 break;
//             }

//             let targetPos = null;

//             if (romulanTarget instanceof Planet) {
//                 targetPos = romulanTarget.position;
//             } else if (romulanTarget instanceof Player && romulanTarget.ship) {
//                 targetPos = romulanTarget.ship.position;
//             }

//             if (!targetPos) {
//                 romulanState = RomulanState.END;
//                 break;
//             }

//             const override = maybeRetargetToAdjacentStar(romulanTarget);
//             if (override) targetPos = override;

//             if (chebyshev(romulan.ship.position, targetPos) > TARGET_RANGE || Math.random() >= ATTACK_CHANCE) {
//                 romulanState = RomulanState.REPAIR;
//                 break;
//             }

//             // 50/50 phaser vs torpedo
//             if (Math.random() < 0.5) {
//                 if (romulanTarget instanceof Player) {
//                     const targetPlayer = players.find(
//                         p => p.ship &&
//                             p.ship.position.h === targetPos.h &&
//                             p.ship.position.v === targetPos.v
//                     );
//                     if (targetPlayer && targetPlayer.ship) {
//                         sendMessageToClient(targetPlayer, "You are under Romulan phaser fire!");
//                         addPendingMessage(romulan, `Romulan ship ${romulan!.ship!.name} fires phasers at ${targetPlayer.ship.name} at ${targetPlayer.ship.position.v}-${targetPlayer.ship.position.h}!`);

//                         // PHADAM parity phaser attack
//                         romulanPhaserAttack(romulan!, targetPlayer);
//                     }
//                 } else {
//                     if (romulanTarget.side === 'FEDERATION' || romulanTarget.side === 'EMPIRE') {
//                         const baseTarget = findBaseAt(romulanTarget.position, romulanTarget.side);
//                         if (baseTarget) {
//                             addPendingMessage(romulan, `Romulan ship ${romulan!.ship!.name} fires phasers at ${baseTarget.side} base at ${baseTarget.position.v}-${baseTarget.position.h}!`);
//                             // PHADAM parity phaser attack against base
//                             romulanPhaserAttack(romulan!, baseTarget);
//                         }
//                     }
//                 }
//             } else {
//                 // Torpedo
//                 if (romulanTarget instanceof Player) {
//                     sendMessageToClient(romulanTarget, "A Romulan torpedo strikes!");
//                     torpedoDamage(romulan!, romulanTarget); // ✅ correct source/target order
//                 } else {
//                     if (romulanTarget.side === 'FEDERATION' || romulanTarget.side === 'EMPIRE') {
//                         const baseTarget = findBaseAt(romulanTarget!.position, romulanTarget.side);
//                         if (baseTarget) {
//                             torpedoDamage(romulan!, baseTarget);
//                         }
//                     }
//                 }
//             }

//             // Romulan survival check (kept as-is)
//             if (romulan.ship.energy <= 0 || romulan.ship.damage >= 10000) {
//                 destroyRomulan();
//                 return;
//             }

//             romulanState = RomulanState.REPAIR;
//             break;
//         }

//         case RomulanState.REPAIR:
//             romulan.ship.romulanStatus.cloaked = true;
//             romulanBaseRepair();
//             romulanState = RomulanState.IDLE;
//             break;

//         case RomulanState.END:
//             romulanTarget = null;
//             romulanState = RomulanState.IDLE;
//             break;
//     }
// }

// function findBaseAt(position: { v: number; h: number }, side: 'FEDERATION' | 'EMPIRE' | 'NEUTRAL') {
//     const arr = side === 'FEDERATION' ? bases.federation : bases.empire;
//     return arr.find(b => b.position.h === position.h && b.position.v === position.v);
// }

// function findClosestTarget(): Target | null {
//     if (!romulan || !romulan.ship) return null;
//     const romPos = romulan!.ship.position;
//     const candidates: Target[] = [];

//     // ships
//     for (const p of players) {
//         if (p.ship && p !== romulan && (p.ship.side === 'FEDERATION' || p.ship.side === 'EMPIRE')) {
//             const d = chebyshev(p.ship.position, romPos);
//             if (d <= TARGET_RANGE) candidates.push(p);
//         }
//     }

//     // bases — fixed: actually push the base
//     for (const side of ['FEDERATION', 'EMPIRE'] as const) {
//         const sideBases = side === 'FEDERATION' ? bases.federation : bases.empire;
//         for (const base of sideBases) {
//             const d = chebyshev(base.position, romPos);
//             if (d <= TARGET_RANGE) candidates.push(base);
//         }
//     }

//     let closest: Target[] = [];
//     let minDist = Infinity;

//     for (const t of candidates) {
//         const pos = t instanceof Player && t.ship ? t.ship.position : (t instanceof Planet ? t.position : undefined);
//         if (!pos) continue;
//         const dist = chebyshev(pos, romPos);
//         if (dist < minDist) {
//             closest = [t];
//             minDist = dist;
//         } else if (dist === minDist) {
//             closest.push(t);
//         }
//     }

//     return closest.length ? closest[Math.floor(Math.random() * closest.length)] : null;
// }

// function maybeRetargetToAdjacentStar(target: Target): { v: number; h: number } | null {
//     let pos = null;

//     if (target instanceof Player && target.ship) {
//         pos = target.ship.position;
//     } else if (target instanceof Planet) {
//         pos = target.position;
//     }
//     if (!pos) return null;

//     for (let dh = -1; dh <= 1; dh++) {
//         for (let dv = -1; dv <= 1; dv++) {
//             if (dh === 0 && dv === 0) continue;
//             const h = pos.h + dh;
//             const v = pos.v + dv;
//             if (stars.some(s => s.position.h === h && s.position.v === v)) return { v, h };
//         }
//     }
//     return null;
// }

// function isPathClear(from: { v: number; h: number }, to: { v: number; h: number }): boolean {
//     if (!romulan || !romulan.ship) return false;

//     const path = [...bresenhamLine(from.v, from.h, to.v, to.h)];
//     path.shift(); // skip start
//     path.pop();   // skip end

//     for (const { v, h } of path) {
//         if (
//             stars.some(obj => obj.position.h === h && obj.position.v === v) ||
//             planets.some(obj => obj.position.h === h && obj.position.v === v) ||
//             players.some(p => p.ship && p !== romulan && p.ship.position.h === h && p.ship.position.v === v)
//         ) return false;
//     }
//     return true;
// }

// export function destroyRomulan(): void { //TODO
//     if (!romulan || !romulan.ship) return;
//     romulan.ship.romulanStatus.cloaked = true;
//     const idx = players.indexOf(romulan);
//     if (idx !== -1) players.splice(idx, 1);
//     romulan = null;
// }

// export function romulanBaseRepair(): void {
//     if (!romulan || !romulan.ship) return;

//     const numPlayers = players.filter(p => p.ship!.side === 'FEDERATION' || p.ship!.side === 'EMPIRE').length;
//     const repairAmount = Math.floor(50 / (numPlayers + 1));

//     for (const side of ['FEDERATION', 'EMPIRE'] as const) {
//         const sideBases = side === 'FEDERATION' ? bases.federation : bases.empire;
//         for (const base of sideBases) {
//             if (base.energy > 0) {
//                 base.energy = Math.min(1000, base.energy + repairAmount);
//             }
//         }
//     }
// }

// function romulanSpeaks(): void {
//     if (!romulan || !romulan.ship) return;

//     const rh = romulan.ship.position.h;
//     const rv = romulan.ship.position.v;
//     const recipients = players.filter(p => p !== romulan && p.ship && chebyshev(p.ship.position, { v: rv, h: rh }) <= TARGET_RANGE);

//     const singleTarget = recipients.length === 1;
//     const msg = generateRomulanMessage(singleTarget);

//     for (const p of recipients) {
//         addPendingMessage(p, `Romulan: ${msg}`);
//     }
// }

// function generateRomulanMessage(single: boolean): string {
//     const lead = single
//         ? ["You have aroused my wrath, ", "You will witness my vengeance, ", "May you be attacked by a slime-devil, ", "I will reduce you to quarks, "]
//         : ["Death to ", "Destruction to ", "I will crush ", "Prepare to die, "];

//     const adjectives = ["mindless ", "worthless ", "ignorant ", "idiotic ", "stupid "];
//     const species = ["sub-Romulan ", "human ", "klingon "];
//     const objects = ["mutant", "cretin", "toad", "worm", "parasite"];

//     return `${lead[Math.floor(Math.random() * lead.length)]}${adjectives[Math.floor(Math.random() * adjectives.length)]}${single ? "" : species[Math.floor(Math.random() * species.length)]}${objects[Math.floor(Math.random() * objects.length)]}${single ? "!" : "s!"}`;
// }

// function relocateRomulan(): void {
//     for (let i = 0; i < 100; i++) {
//         const v = Math.floor(Math.random() * GRID_HEIGHT) + 1;
//         const h = Math.floor(Math.random() * GRID_WIDTH) + 1;
//         if (!findObjectAtPosition(v, h)) {
//             if (romulan && romulan.ship) {
//                 romulan!.ship.position = { v, h };
//             }
//         }
//     }
// }

// // === PHADAM parity phaser attack for Romulan ===
// function romulanPhaserAttack(attacker: Player, target: Player | Planet) {
//     if (!attacker.ship) return { hita: 0, isDestroyed: false };

//     const isShip = target instanceof Player && !!target.ship;
//     const isBase = target instanceof Planet && target.isBase;

//     const rawShieldEnergy = isShip ? (target as Player).ship!.shieldEnergy : (target as Planet).energy;
//     const rawShieldMax = isShip ? MAX_SHIELD_ENERGY : 1000;

//     const distance = chebyshev(
//         attacker.ship.position,
//         isShip ? (target as Player).ship!.position : (target as Planet).position
//     );

//     const shooterDamaged =
//         !!attacker.ship.devices?.phaser || !!attacker.ship.devices?.computer;

//     // Use standard phaser power (PHACON default 200); Romulan has no energy spend
//     const { hita, newShieldEnergy } = phadamCore({
//         targetIsBase: !!isBase,
//         rawShieldEnergy,
//         rawShieldMax,
//         distance,
//         shooterDamaged,
//         phit: 200,
//     });

//     // write back shield drain
//     if (isShip) (target as Player).ship!.shieldEnergy = newShieldEnergy;
//     else (target as Planet).energy = newShieldEnergy;

//     // ship device crit + jitter BEFORE hull
//     let finalHit = hita;
//     if (isShip && Math.random() < CRIT_CHANCE) {
//         const crit = applyShipCriticalParity(target as Player, hita);
//         finalHit = crit.hita;
//     }

//     // apply to hull using the shared resolver (keeps scoring consistent)
//     // import from torpedo.js where your applyDamage is defined
//     // NOTE: we import phadamCore & applyShipCriticalParity above; applyDamage is used indirectly by torpedo path.
//     // If applyDamage is exported from another module, adjust the import path accordingly.

//     return applyDamage(attacker, target, finalHit, Math.random());
// }

// // (Legacy helper kept for reference — no longer used)
// // function romulanPhaserDamage(distance: number, romulan: Player): number {
// //   let baseHit = Math.pow(0.9 + 0.02 * Math.random(), distance); // Fortran: pwr(0.9–0.92, id)
// //   if (romulan.ship && (romulan.ship.devices.phaser > 0 || romulan.ship.devices.computer > 0)) {
// //     baseHit *= 0.8; // Fortran: hit *= 0.8 if damaged
// //   }
// //   return baseHit;
// // }


// function computeRomulanMovement(
//     from: { v: number; h: number },
//     to: { v: number; h: number },
//     maxSteps = 4
// ): { v: number; h: number } {
//     // Chebyshev distance (max axis delta)
//     const dv = to.v - from.v;
//     const dh = to.h - from.h;

//     const dist = Math.max(Math.abs(dv), Math.abs(dh));
//     if (dist === 0) return from;

//     // never enter the target tile: stop 1 short if needed
//     const steps = Math.min(maxSteps, Math.max(0, dist - 1));

//     // move diagonally first, then along the dominant remaining axis
//     const sv = Math.sign(dv);
//     const sh = Math.sign(dh);

//     const diag = Math.min(steps, Math.min(Math.abs(dv), Math.abs(dh))); // diagonal steps
//     const rem = steps - diag;

//     const extraV = Math.min(rem, Math.max(0, Math.abs(dv) - diag));
//     const extraH = Math.min(rem, Math.max(0, Math.abs(dh) - diag));

//     let v = from.v + sv * (diag + extraV);
//     let h = from.h + sh * (diag + extraH);

//     // clamp to galaxy bounds
//     v = Math.max(1, Math.min(GRID_HEIGHT, v));
//     h = Math.max(1, Math.min(GRID_WIDTH, h));

//     return { v, h };
// }

// Expose cooldowns in case UI/debug wants to surface them
export function getRomulanCooldowns() {
    const now = Date.now();
    return {
        phasersMs: Math.max(0, rppausUntil - now),
        torpedoesMs: Math.max(0, rtpausUntil - now),
    };
}
