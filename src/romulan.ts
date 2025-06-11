// Romulan AI Canonical Implementation (State Machine + Fortran Fidelity)

import { Player } from './player.js';
import { NullSocket } from './util/nullsocket.js';
import {
    GRID_WIDTH,
    GRID_HEIGHT,
    settings
} from './settings.js';
import {
    players,
    bases,
    stars,
    planets,
} from './game.js';
import { addPendingMessage, sendMessageToClient } from './communication.js';
import { applyPhaserShipDamage, applyPhaserBaseDamage } from './phaser.js';
import { applyTorpedoShipDamage, applyTorpedoBaseDamage } from './torpedo.js';
import { bresenhamLine, chebyshev, findEmptyLocation, findObjectAtPosition } from './coords.js';
import { Planet } from './planet.js';
import { pointsManager } from './game.js';

const TARGET_RANGE = 20;
const ATTACK_CHANCE = 1 / 3;
let romulanCounter = 0;
export let romulan: Player | null = null;

enum RomulanState {
    IDLE,
    SPEAK,
    SEARCH,
    MOVE,
    DECLOAK,
    PREATTACK,
    ATTACK,
    REPAIR,
    END
}

let romulanState = RomulanState.IDLE;

let romulanTarget: Target | null = null;

type Target = Planet | Player;

export function maybeSpawnRomulan(): void {
    if (!settings.generated) return;
    romulanCounter++;
    const numPlayers = players.length;

    if ((!romulan || !romulan.ship) && romulanCounter >= numPlayers * 3 && Math.floor(Math.random() * 5) === 4) {
        spawnRomulan();
        romulanCounter = 0;
    }
}

export function spawnRomulan(): void {
    if (romulan && romulan.ship) return;

    pointsManager.incrementShipsCommissioned('ROMULAN');

    romulan = new Player(new NullSocket());
    romulan.settings.name = 'ROMULAN';
    if (romulan.ship) {
        romulan.ship.name = 'ROMULAN';
        romulan.ship.side = 'ROMULAN';
        romulan.ship.romulanStatus = { isRomulan: true, isRevealed: false, cloaked: true };
        romulan.ship.energy = 5000;
        romulan.ship.damage = 0;
        romulan.ship.shieldEnergy = 0;


        const position = findEmptyLocation();
        if (position) {
            romulan.ship.position = position;
            players.push(romulan);
        }
    }
}

export function updateRomulan(): void {
    if (!romulan || !romulan.ship) return;

    switch (romulanState) {
        case RomulanState.IDLE:
            romulanState = RomulanState.SPEAK;
            break;

        case RomulanState.SPEAK:
            if (Math.random() < 1 / 10) romulanSpeaks();
            romulanState = RomulanState.SEARCH;
            break;

        case RomulanState.SEARCH:
            romulanTarget = findClosestTarget();
            if (romulanTarget) {
                romulanState = RomulanState.MOVE;
            } else {
                relocateRomulan();
                romulanState = RomulanState.END;
            }
            break;

        case RomulanState.MOVE: {
            if (!romulanTarget) {
                romulanState = RomulanState.END;
                break;
            }

            const destination = romulanTarget instanceof Player
                ? romulanTarget.ship?.position
                : romulanTarget.position;

            if (!destination) {
                romulanState = RomulanState.END;
                break;
            }

            if (romulan && romulan.ship && !isPathClear(romulan.ship.position, destination)) {
                romulanState = RomulanState.END;
                break;
            }

            romulan.ship.position = computeRomulanMovement(romulan.ship.position, destination);
            romulanState = RomulanState.DECLOAK;
            romulan.ship.romulanStatus.cloaked = false;
            break;
        }

        case RomulanState.DECLOAK:
            romulanState = RomulanState.PREATTACK;
            break;

        case RomulanState.PREATTACK:
            romulanState = RomulanState.ATTACK;
            break;

        case RomulanState.ATTACK: {
            if (!romulanTarget) {
                romulanState = RomulanState.END;
                break;
            }

            let targetPos = null;

            if (romulanTarget instanceof Planet) {
                targetPos = romulanTarget.position;
            } else if (romulanTarget instanceof Player && romulanTarget.ship) {
                targetPos = romulanTarget.ship.position;
            }

            if (!targetPos) {
                romulanState = RomulanState.END;
                break;
            }

            const override = maybeRetargetToAdjacentStar(romulanTarget);
            if (override) targetPos = override;

            if (chebyshev(romulan.ship.position, targetPos) > TARGET_RANGE || Math.random() >= ATTACK_CHANCE) {
                romulanState = RomulanState.REPAIR;
                break;
            }

            if (Math.random() < 0.5) {
                if (romulanTarget instanceof Player) {
                    const targetPlayer = players.find(
                        p => p.ship &&
                            p.ship.position.h === targetPos.h &&
                            p.ship.position.v === targetPos.v
                    );
                    if (targetPlayer && targetPlayer.ship) {
                        const distance = chebyshev(romulan.ship.position, targetPlayer.ship.position);
                        const hit = romulanPhaserDamage(distance, romulan);
                        const powfac = targetPlayer.ship.shieldsUp ? 40 : 80; // Fortran: powfac halved if shields up
                        const phit = 0.4; // 200 energy equivalent

                        sendMessageToClient(targetPlayer, "You are under Romulan phaser fire!");
                        addPendingMessage(romulan, `Romulan ship ${romulan.ship.name} fires phasers at ${targetPlayer.ship.name} at ${targetPlayer.ship.position.v}-${targetPlayer.ship.position.h}!`);
                        applyPhaserShipDamage(romulan, targetPlayer, hit, powfac, phit);
                    }
                } else {
                    if (romulanTarget.side === 'FEDERATION' || romulanTarget.side === 'EMPIRE') {
                        const baseTarget = findBaseAt(romulanTarget.position, romulanTarget.side);
                        if (baseTarget) {
                            const distance = chebyshev(romulan.ship.position, romulanTarget.position);

                            const powfac = 40; // Fortran: powfac = 40 for bases
                            const phit = 0.4; // 200 energy equivalent (matches original 200 damage)
                            const hit = romulanPhaserDamage(distance, romulan);
                            addPendingMessage(romulan, `Romulan ship ${romulan.ship.name} fires phasers at ${baseTarget.side} base at ${baseTarget.position.v}-${baseTarget.position.h}!`);
                            applyPhaserBaseDamage(romulan, baseTarget, hit, powfac, phit); // Fixed TS2554
                        }
                    }
                }
            } else {
                const hit = 4000 + 4000 * Math.random();
                if (romulanTarget instanceof Player) {
                    sendMessageToClient(romulanTarget, "A Romulan torpedo strikes!");
                    applyTorpedoShipDamage(romulanTarget, romulan, hit, false);
                } else {
                    if (romulanTarget.side === 'FEDERATION' || romulanTarget.side === 'EMPIRE') {
                        const baseTarget = findBaseAt(romulanTarget!.position, romulanTarget.side);
                        if (baseTarget) {
                            applyTorpedoBaseDamage(romulan, baseTarget, 1);
                        }
                    }
                }
            }

            if (romulan.ship.energy <= 0 || romulan.ship.damage >= 10000) {
                destroyRomulan();
                return;
            }

            romulanState = RomulanState.REPAIR;
            break;
        }

        case RomulanState.REPAIR:
            romulan.ship.romulanStatus.cloaked = true;
            romulanBaseRepair();
            romulanState = RomulanState.IDLE;
            break;

        case RomulanState.END:
            romulanTarget = null;
            romulanState = RomulanState.IDLE;
            break;
    }
}

function findBaseAt(position: { v: number; h: number }, side: 'FEDERATION' | 'EMPIRE' | 'NEUTRAL') {
    const arr = side === 'FEDERATION' ? bases.federation : bases.empire;
    return arr.find(b => b.position.h === position.h && b.position.v === position.v);
}

function findClosestTarget(): Target | null {
    if (!romulan || !romulan.ship) return null;
    const romPos = romulan!.ship.position;
    const candidates: Target[] = [];

    for (const p of players) {
        if (p.ship && p !== romulan && (p.ship.side === 'FEDERATION' || p.ship.side === 'EMPIRE')) {
            const d = chebyshev(p.ship.position, romPos);
            if (d <= TARGET_RANGE) candidates.push(p);
        }
    }

    for (const side of ['FEDERATION', 'EMPIRE'] as const) {
        const sideBases = side === 'FEDERATION' ? bases.federation : bases.empire;
        for (const base of sideBases) {
            const d = chebyshev(base.position, romPos);
            if (d <= TARGET_RANGE) candidates.push();
        }
    }

    let closest: Target[] = [];
    let minDist = Infinity;

    for (const t of candidates) {
        const pos = t instanceof Player && t.ship ? t.ship.position : (t instanceof Planet ? t.position : undefined);
        if (!pos) continue;
        const dist = chebyshev(pos, romPos);
        if (dist < minDist) {
            closest = [t];
            minDist = dist;
        } else if (dist === minDist) {
            closest.push(t);
        }
    }

    return closest.length ? closest[Math.floor(Math.random() * closest.length)] : null;
}

function maybeRetargetToAdjacentStar(target: Target): { v: number; h: number } | null {
    let pos = null;

    if (target instanceof Player && target.ship) {
        pos = target.ship.position;
    } else if (target instanceof Planet) {
        pos = target.position;
    }
    if (!pos) return null;

    for (let dh = -1; dh <= 1; dh++) {
        for (let dv = -1; dv <= 1; dv++) {
            if (dh === 0 && dv === 0) continue;
            const h = pos.h + dh;
            const v = pos.v + dv;
            if (stars.some(s => s.position.h === h && s.position.v === v)) return { v, h };
        }
    }
    return null;
}

function isPathClear(from: { v: number; h: number }, to: { v: number; h: number }): boolean {
    if (!romulan || !romulan.ship) return false;

    const path = [...bresenhamLine(from.v, from.h, to.v, to.h)];
    path.shift(); // skip start
    path.pop();   // skip end

    for (const { v, h } of path) {
        if (
            stars.some(obj => obj.position.h === h && obj.position.v === v) ||
            planets.some(obj => obj.position.h === h && obj.position.v === v) ||
            players.some(p => p.ship && p !== romulan && p.ship.position.h === h && p.ship.position.v === v)
        ) return false;
    }
    return true;
}

export function destroyRomulan(): void { //TODO
    if (!romulan || !romulan.ship) return;
    romulan.ship.romulanStatus.cloaked = true;
    const idx = players.indexOf(romulan);
    if (idx !== -1) players.splice(idx, 1);
    romulan = null;
}

export function romulanBaseRepair(): void {
    if (!romulan || !romulan.ship) return;

    const numPlayers = players.filter(p => p.ship!.side === 'FEDERATION' || p.ship!.side === 'EMPIRE').length;
    const repairAmount = Math.floor(50 / (numPlayers + 1));

    for (const side of ['FEDERATION', 'EMPIRE'] as const) {
        const sideBases = side === 'FEDERATION' ? bases.federation : bases.empire;
        for (const base of sideBases) {
            if (base.energy > 0) {
                base.energy = Math.min(1000, base.energy + repairAmount);
            }
        }
    }
}

function romulanSpeaks(): void {
    if (!romulan || !romulan.ship) return;

    const rh = romulan.ship.position.h;
    const rv = romulan.ship.position.v;
    const recipients = players.filter(p => p !== romulan && p.ship && chebyshev(p.ship.position, { v: rv, h: rh }) <= TARGET_RANGE);

    const singleTarget = recipients.length === 1;
    const msg = generateRomulanMessage(singleTarget);

    for (const p of recipients) {
        addPendingMessage(p, `Romulan: ${msg}`);
    }
}

function generateRomulanMessage(single: boolean): string {
    const lead = single
        ? ["You have aroused my wrath, ", "You will witness my vengeance, ", "May you be attacked by a slime-devil, ", "I will reduce you to quarks, "]
        : ["Death to ", "Destruction to ", "I will crush ", "Prepare to die, "];

    const adjectives = ["mindless ", "worthless ", "ignorant ", "idiotic ", "stupid "];
    const species = ["sub-Romulan ", "human ", "klingon "];
    const objects = ["mutant", "cretin", "toad", "worm", "parasite"];

    return `${lead[Math.floor(Math.random() * lead.length)]}${adjectives[Math.floor(Math.random() * adjectives.length)]}${single ? "" : species[Math.floor(Math.random() * species.length)]}${objects[Math.floor(Math.random() * objects.length)]}${single ? "!" : "s!"}`;
}

function relocateRomulan(): void {
    for (let i = 0; i < 100; i++) {
        const v = Math.floor(Math.random() * GRID_HEIGHT) + 1;
        const h = Math.floor(Math.random() * GRID_WIDTH) + 1;
        if (!findObjectAtPosition(v, h)) {
            if (romulan && romulan.ship) {
                romulan!.ship.position = { v, h };
            }
        }
    }
}



function computeRomulanMovement(
    from: { v: number; h: number },
    to: { v: number; h: number },
    maxSteps = 4
): { v: number; h: number } {
    const dv = to.v - from.v;
    const dh = to.h - from.h;

    const stepX = Math.sign(dv);
    const stepY = Math.sign(dh);

    const distance = Math.max(Math.abs(dh), Math.abs(dv));
    const steps = Math.min(maxSteps, Math.max(0, distance - 1)); // avoid entering target tile

    let h = from.h + stepX * steps;
    let v = from.v + stepY * steps;

    // Clamp to galaxy bounds
    h = Math.max(1, Math.min(GRID_WIDTH, h));
    v = Math.max(1, Math.min(GRID_HEIGHT, v));

    return { v, h };
}

function romulanPhaserDamage(distance: number, romulan: Player): number {
    let baseHit = Math.pow(0.9 + 0.02 * Math.random(), distance); // Fortran: pwr(0.9–0.92, id)
    if (romulan.ship && (romulan.ship.devices.phaser > 0 || romulan.ship.devices.computer > 0)) {
        baseHit *= 0.8; // Fortran: hit *= 0.8 if damaged
    }
    return baseHit;
}