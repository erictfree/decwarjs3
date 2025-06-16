import { Player } from './player.js';
import { Command } from './command.js';
import {
    DESTRUCTION_DAMAGE_THRESHOLD,
    PHASER_COOLDOWN,
    OutputSetting,
    STARBASE_PHASER_RANGE,
    MAX_SHIELD_ENERGY,
    Side,
    DEFAULT_BASE_ENERGY
} from './settings.js';
import { sendMessageToClient, addPendingMessage, sendMessageToOthers } from './communication.js';
import { chebyshev, ocdefCoords, getCoordsFromCommandArgs } from './coords.js';
import { Planet } from './planet.js';
import { players, planets, bases, removePlayerFromGame, checkEndGame, pointsManager } from './game.js';
import { isMainThread } from 'worker_threads';
import { Ship } from './ship.js';

export function phaserCommand(player: Player, command: Command): void {
    if (!player.ship) {
        sendMessageToClient(player, "You cannot fire phasers — you have no ship.");
        return;
    }

    let args = command.args;
    const now = Date.now();
    const [ph1, ph2] = player.ship.cooldowns.phasersAvailableAt;
    const bankIndex = ph1 <= ph2 ? 0 : 1;
    let energy = NaN;

    if (!player.ship.isDeviceOperational("phaser")) return;

    if (now < player.ship.cooldowns.phasersAvailableAt[bankIndex]) {
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, "PH > RCHG"); break;
            case "MEDIUM": sendMessageToClient(player, "Phasers unavailable — recharging."); break;
            case "LONG": sendMessageToClient(player, "Both phaser banks are currently recharging."); break;
        }
        return;
    }

    // Parse arguments
    if (command.args.length === 2) {
        args = [player.settings.icdef, ...command.args];  // v h
    } else if (command.args.length === 3) { // either energy v h, or mode v h
        energy = parseInt(command.args[0], 10);
        if (!Number.isNaN(energy)) {
            args[0] = player.settings.icdef // remove energy and treat as normal
        }
    } else if (command.args.length === 4) { // mode energy v h
        energy = parseInt(command.args[1], 10);
        if (Number.isNaN(energy)) {
            switch (player.settings.output) {
                case "SHORT":
                    sendMessageToClient(player, "PH > BAD E");
                    break;
                case "MEDIUM":
                    sendMessageToClient(player, "Invalid phaser energy input.");
                    break;
                case "LONG":
                default:
                    sendMessageToClient(player, "Bad energy value provided. Phaser command aborted.");
                    break;
            }
            return;
        } else {
            args = command.args.slice(0, 1).concat(command.args.slice(2));
        }
    }

    if (Number.isNaN(energy)) {
        energy = 200;
    }
    energy = Math.min(Math.max(energy, 50), 500);

    const shieldPenalty = player.ship.shieldsUp ? 200 : 0;
    if (shieldPenalty > 0) {
        switch (player.settings.output) {
            case "LONG": sendMessageToClient(player, "High speed shield control activated."); break;
        }
    }

    const totalEnergyCost = energy + shieldPenalty;
    if (player.ship.energy < totalEnergyCost) {
        const e = player.ship.energy.toFixed(1);
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, `PH > NO E ${e}`); break;
            case "MEDIUM": sendMessageToClient(player, `Insufficient energy: ${e}`); break;
            case "LONG": sendMessageToClient(player, `Insufficient energy to fire phasers. Available energy: ${e}`); break;
        }
        return;
    }

    const { position: { v: targetV, h: targetH } } = getCoordsFromCommandArgs(player, args, player.ship.position.v, player.ship.position.h, true);
    const distance = chebyshev(player.ship.position, { v: targetV, h: targetH });

    if (distance > 10) {
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, "PH > RANGE"); break;
            case "MEDIUM": sendMessageToClient(player, "Target exceeds phaser range."); break;
            case "LONG": sendMessageToClient(player, "Target out of phaser range (maximum 10 sectors)."); break;
        }
        return;
    }

    player.ship.energy -= totalEnergyCost;
    player.ship.condition = "RED";

    const target = players.find(p => p.ship && p.ship.position.h === targetH && p.ship.position.v === targetV) ||
        planets.find(p => p.position.h === targetH && p.position.v === targetV && p.isBase);
    if (!target) {
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, "PH > MISS"); break;
            case "MEDIUM": sendMessageToClient(player, "No target present."); break;
            case "LONG": sendMessageToClient(player, "No valid target at that location for phaser strike."); break;
        }
        return;
    }
    const targetSide = target instanceof Planet ? target.side : target.ship?.side;  //TODO
    if (targetSide === player.ship.side) {
        sendMessageToClient(player, "Cannot fire phasers at a friendly target.");
        return;
    }

    //console.log("PHADAM energy", energy, energy / 500);
    // const result = calculateAndApplyPhaserDamage(player, target, energy);
    if (target instanceof Player) {
        const result = calcShipPhaserDamage(energy, player, target);
    } else if (target instanceof Planet) {
        const result = calcBasePhaserDamage(energy, player, target);
    }

    // let powfac = 80;
    // if ((target instanceof Player && target.ship && target.ship.shieldsUp) || (target instanceof Planet && target.isBase)) powfac = 40;
    // let baseHit = Math.pow(0.9 + 0.02 * Math.random(), distance);
    // if (player.ship.devices.phaser > 0 || player.ship.devices.computer > 0) baseHit *= 0.8;

    // if (target instanceof Player) {
    //     applyPhaserShipDamage(player, target, baseHit, powfac, energy / 500);
    // } else if (target instanceof Planet) {
    //     applyPhaserBaseDamage(player, target, baseHit, powfac, energy / 500);
    // }

    // if (target instanceof Planet) {
    //     if (target.isBase) {
    //         applyPhaserBaseDamage(player, target, baseHit, powfac, energy / 500);
    //     } else {
    //         if (target.builds > 0 && Math.random() < 0.25) {
    //             target.builds = Math.max(0, target.builds - 1);
    //             sendMessageToClient(player, formatPhaserPlanetHit(player, target));
    //         } else {
    //             // No effect message
    //         }
    //     }
    // }

    // const damagePenalty = (player.ship.devices.phaser || 0) / 100;
    // const cooldown = PHASER_COOLDOWN + Math.random() * PHASER_COOLDOWN + damagePenalty;
    // player.ship.cooldowns.phasersAvailableAt[bankIndex] = now + cooldown;

    // if (Math.random() * 100 < (energy - 50) * (60 / 450) + 5) {
    //     const overheatDamage = 300 + Math.random() * 600;
    //     player.ship.devices.phaser += overheatDamage;
    //     const dmg = Math.round(overheatDamage);
    //     switch (player.settings.output) {
    //         case "SHORT": sendMessageToClient(player, `PH > OH ${dmg}`); break;
    //         case "MEDIUM": sendMessageToClient(player, `Phaser bank overheated (${dmg} dmg)`); break;
    //         case "LONG": sendMessageToClient(player, `Phaser bank overheated! ${dmg} damage sustained to internal systems.`); break;
    //     }
    // }

    // if (player.ship.romulanStatus.isRomulan) {
    //     player.ship.romulanStatus.isRevealed = true;
    //     setTimeout(() => {
    //         if (player.ship) player.ship.romulanStatus.isRevealed = false;
    //     }, 5000);
    // }
}

// export function applyPhaserShipDamage(source: Player | Planet, target: Player, damage: number, powfac: number, phit: number): void {
//     if (source instanceof Player && !source.ship) return;
//     if (!target.ship) return;

//     const sourceType = source instanceof Player ? "Player" : "Planet";
//     const sourceSide = source instanceof Player ? source.ship!.side : source.side;  //TODO: check if this is correct
//     const sourcePos = source instanceof Player ? source.ship!.position : source.position;
//     const targetSide = target.ship.side;
//     const targetName = target.ship.name;
//     const targetPos = target.ship.position;

//     if (damage <= 0) {
//         if (source instanceof Player) {
//             const msg = `${sourceType} (${sourceSide}) at ${sourcePos} fires phasers at ${targetSide} ship ${targetName} at ${targetPos} but misses`;
//             sendMessageToClient(source, msg);
//         }
//         return;
//     }

//     let hita = damage;
//     let effectiveDamage = damage;
//     if (target.ship.shieldsUp) {
//         const shieldEnergy = target.ship.shieldEnergy || 1000; // Fortran: KSSHPC (0–1000)
//         hita = damage;
//         effectiveDamage = (1000 - shieldEnergy) * hita * 0.001;
//         target.ship.shieldEnergy = Math.max(0, shieldEnergy - (hita * powfac * phit * Math.max(shieldEnergy * 0.001, 0.1) + 10) * 0.03);
//         if (target.ship.shieldEnergy <= 0) target.ship.shieldsUp = false;
//     } else {
//         effectiveDamage = hita * powfac * phit;
//     }

//     // Apply damage (Fortran: block 500)
//     target.ship.energy = Math.max(0, target.ship.energy - effectiveDamage);
//     target.ship.damage += effectiveDamage;

//     // Critical hit (Fortran: block 400)
//     if (effectiveDamage * (Math.random() + 0.1) >= 1700) {
//         const deviceKeys = Object.keys(target.ship.devices) as (keyof typeof target.ship.devices)[];
//         const randomDevice = deviceKeys[Math.floor(Math.random() * deviceKeys.length)];
//         target.ship.devices[randomDevice] = Math.min(target.ship.devices[randomDevice] + effectiveDamage / 2, 1000);
//         if (randomDevice === "shield") target.ship.shieldsUp = false;
//         addPendingMessage(target, `CRITICAL HIT: ${randomDevice} damaged (${Math.round(effectiveDamage / 2)})!`);
//     }

//     // Update condition (Fortran: KSPCON = RED)
//     if (target.ship.shieldEnergy <= 0 || target.ship.energy <= 200) {
//         target.ship.condition = 'RED';
//     } else if (target.ship.shieldEnergy <= 250 || target.ship.energy <= 500) {
//         target.ship.condition = 'YELLOW';
//     } else {
//         target.ship.condition = 'GREEN';
//     }

//     const sourceName = source instanceof Player && source.ship ? source.ship.name : source instanceof Planet ? "Starbase" : "Unknown";
//     const targetShieldPct = target.ship.computeShieldPercent();

//     if (source instanceof Player) {
//         const attackerMessage = formatPhaserHit({
//             attacker: sourceName,
//             target: target.ship.name ?? "Unknown",
//             damage: effectiveDamage,
//             attackerPos: sourcePos,
//             targetShieldPercent: targetShieldPct,
//             outputLevel: source.settings.output
//         });
//         sendMessageToClient(source, attackerMessage);

//         if (source.ship) {
//             if (target.ship.romulanStatus?.isRomulan) {
//                 pointsManager.addDamageToRomulans(effectiveDamage, source, source.ship.side);
//             } else {
//                 pointsManager.addDamageToEnemies(effectiveDamage, source, source.ship.side);
//             }
//         }

//         const targetMessage = formatPhaserHit({
//             attacker: sourceName,
//             target: target.ship.name ?? "Unknown",
//             damage: effectiveDamage,
//             attackerPos: sourcePos,
//             targetShieldPercent: targetShieldPct,
//             outputLevel: target.settings.output
//         });
//         addPendingMessage(target, targetMessage);

//         sendFormattedMessageToObservers({
//             origin: target.ship.position,
//             attacker: sourceName,
//             target: target.ship.name ?? "Unknown",
//             damage: effectiveDamage,
//             targetShieldPercent: targetShieldPct,
//             formatFunc: formatPhaserHit
//         });

//         if (target.ship.energy <= 0 || target.ship.damage >= DESTRUCTION_DAMAGE_THRESHOLD) {
//             sendMessageToClient(target, `Your ship was destroyed by ${sourceName} with phasers.`);
//             removePlayerFromGame(target);
//             if (source instanceof Player) {
//                 sendMessageToClient(source, `${sourceName} destroyed ${targetSide} ship ${targetName} at ${targetPos} with phasers.`);
//                 if (source.ship)
//                     pointsManager.addEnemiesDestroyed(1, source, source.ship.side); // Fortran: 5000 points
//             }
//         }
//     }
// }

// export function applyPhaserBaseDamage(player: Player, target: Planet, damage: number, powfac: number, phit: number): void {
//     if (!player.ship) return;

//     const baseEnergy = target.energy || 1000; // Fortran: base(j,3,nplc-2) (0–1000)
//     if (baseEnergy === 1000 && !target.hasCriedForHelp) {
//         target.hasCriedForHelp = true;
//         target.callForHelp(target.position.v, target.position.h, target.side);
//     }

//     // Apply damage (Fortran: block 900)
//     const hita = damage;
//     const effectiveDamage = (1000 - baseEnergy) * hita * 0.001;
//     target.energy = Math.max(0, baseEnergy - (hita * powfac * phit * Math.max(baseEnergy * 0.001, 0.1) + 10) * 0.03);
//     target.energy = Math.max(0, Math.floor(target.energy - effectiveDamage * 0.01)); // Fortran: hita * 0.01

//     // Critical hit (Fortran: block 1400)
//     if (Math.random() < 0.2) { // Fortran: iran(5) == 5
//         target.energy = Math.max(0, target.energy - (50 + Math.random() * 100));
//     }

//     pointsManager.addDamageToBases(effectiveDamage, player, player.ship.side);
//     sendMessageToClient(player, formatPhaserBaseHit({ player, base: target, damage: effectiveDamage }));

//     if (target.energy <= 0) {
//         target.isBase = false;
//         const baseArray = target.side === "FEDERATION" ? bases.federation : bases.empire;
//         const index = baseArray.findIndex(b => b.position.v === target.position.v && b.position.h === target.position.h);
//         if (index !== -1) baseArray.splice(index, 1);
//         pointsManager.addDamageToBases(10000, player, player.ship.side); // Fortran: 10000 points
//         sendMessageToClient(player, formatPhaserBaseDestroyed({ player, base: target }));
//         checkEndGame();
//     }
// }

function starbasePhaserDamage(distance: number, target: Player): number {
    let baseHit = Math.pow(0.9 + 0.02 * Math.random(), distance); // Fortran: pwr(0.9–0.92, id)
    if (target.ship && (target.ship.devices.phaser > 0 || target.ship.devices.computer > 0)) {
        baseHit *= 0.8; // Fortran: hit *= 0.8 if damaged
    }
    return baseHit;
}

export function starbasePhaserDefense(triggeringPlayer: Player): void {
    if (!triggeringPlayer.ship) return;
    const isRomulan = triggeringPlayer.ship.romulanStatus?.isRomulan ?? false;

    const targetSides: ("FEDERATION" | "EMPIRE")[] = isRomulan
        ? ["FEDERATION", "EMPIRE"]
        : triggeringPlayer.ship.side === "FEDERATION"
            ? ["EMPIRE"]
            : ["FEDERATION"];

    for (const side of targetSides) {
        const sideBases = side === "FEDERATION" ? bases.federation : bases.empire;

        for (const base of sideBases) {
            if (base.energy <= 0) continue;

            for (const player of players) {
                if (!player.ship) continue;
                if (player.ship.romulanStatus?.cloaked) continue;
                if (player.ship.side === side && !player.ship.romulanStatus?.isRomulan) continue;

                const distance = chebyshev(player.ship.position, base.position);
                if (distance > STARBASE_PHASER_RANGE) continue;

                const baseHit = starbasePhaserDamage(distance, player);
                const powfac = player.ship.shieldsUp ? 40 : 80; // Fortran: powfac halved if shields up
                const phit = 0.4; // 200 energy equivalent (200/500)

                addPendingMessage(player, `\r\n** ALERT ** Starbase at ${base.position.v}-${base.position.h} opens fire!`);
                addPendingMessage(player, `You are under automatic phaser attack from enemy starbase!`);

                //applyPhaserShipDamage(base, player, baseHit, powfac, phit); // Fixed TS2554 TODO
                calculateAndApplyPhaserDamage(base, player, baseHit);
            }
        }
    }
}

export function formatPhaserHit({
    attacker,
    target,
    damage,
    attackerPos,
    targetShieldPercent,
    outputLevel
}: {
    attacker: string;
    target: string;
    damage: number;
    attackerPos: { v: number, h: number };
    targetShieldPercent: number;
    outputLevel: OutputSetting;
}): string {
    const dmg = Math.round(damage);
    const shields = Math.round(targetShieldPercent);

    switch (outputLevel) {
        case "LONG":
            return `${attacker} @${attackerPos.v}-${attackerPos.h} makes ${dmg} unit phaser hit on ${target}, ${shields >= 0 ? "+" : ""}${shields}%`;
        case "MEDIUM":
            return `${attacker[0]} @${attackerPos.v}-${attackerPos.h} ${dmg}P ${target[0]}, ${shields >= 0 ? "+" : ""}${shields}%`;
        case "SHORT":
            return `${attacker[0]} ${attackerPos.v}-${attackerPos.h} ${dmg}P ${target[0]} ${shields >= 0 ? "+" : ""}${shields}`;
    }
}

export function formatPhaserBaseHit({
    player,
    base,
    damage
}: {
    player: Player;
    base: Planet;
    damage: number;
}): string {
    if (!player.ship) return "The phaser malfunctioned.";
    const dmg = Math.round(damage);
    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, base.position);
    const attacker = player.ship.name;
    const output = player.settings.output;

    switch (output) {
        case "LONG":
            return `${attacker} fires phasers and hits ${base.side} base at ${coords} for ${dmg} units`;
        case "MEDIUM":
            return `${attacker?.[0]} PH ${base.side[0]}B @${coords} ${dmg}`;
        case "SHORT":
            return `${attacker?.[0]} > ${base.side[0]}B ${coords} ${dmg}`;
        default:
            return `${attacker} fires phasers and hits ${base.side} base at ${coords} for ${dmg} units`;
    }
}

export function formatPhaserPlanetHit(player: Player, planet: Planet): string {
    if (!player.ship) return "The phaser malfunctioned.";
    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, planet.position);
    const name = player.ship.name;
    switch (player.settings.output) {
        case "SHORT":
            return `${name?.[0]} > P ${coords} ${planet.builds}B`;
        case "MEDIUM":
            return `${name} hit planet @${coords}, builds left: ${planet.builds}`;
        case "LONG":
            return `${name} fired phasers at planet located at ${coords}. Remaining builds: ${planet.builds}`;
    }
}

export function formatPhaserBaseDestroyed({ player, base }: { player: Player; base: Planet }): string {
    if (!player.ship) return "The phaser malfunctioned.";
    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, base.position);
    const output = player.settings.output;
    switch (output) {
        case "SHORT":
            return `☠ ${base.side[0]}B ${coords}`;
        case "MEDIUM":
            return `${base.side} base destroyed at ${coords}`;
        case "LONG":
            return `The ${base.side} base at ${coords} has been destroyed!`;
    }
}

export function sendFormattedMessageToObservers({
    origin,
    attacker,
    target,
    damage,
    targetShieldPercent,
    formatFunc
}: {
    origin: { v: number, h: number };
    attacker: string;
    target: string;
    damage: number;
    targetShieldPercent: number;
    formatFunc: (opts: {
        attacker: string;
        target: string;
        damage: number;
        attackerPos: { v: number, h: number };
        targetShieldPercent: number;
        outputLevel: OutputSetting;
    }) => string;
}): void {
    for (const other of players) {
        if (!other.radioOn) continue;
        if (!other.ship) continue;

        if (chebyshev(origin, other.ship.position) > 10) continue;

        const msg = formatFunc({
            attacker,
            target,
            damage,
            attackerPos: origin,
            targetShieldPercent,
            outputLevel: other.settings.output
        });

        addPendingMessage(other, msg);
    }
}
// Shared damage application (label 400 onward)
export function applyDamage(
    source: Player | Planet,
    target: Player | Planet,
    hita: number,
    rana: number
): { hita: number; isDestroyed: boolean; shieldStrength: number; shieldsUp: boolean; critdm: number; } | null {
    let critdm = 0;
    let isDestroyed = false;
    let shieldStrength = 0;
    let shieldsUp = false;
    let critDevice;

    // Critical hit (ships only, label 400)
    if (target instanceof Player && hita * (rana + 0.1) >= 1700) {
        if (!target.ship) return null;

        hita = hita / 2.0;
        const deviceKeys = Object.keys(target.ship.devices);
        let critdv = deviceKeys[Math.floor(deviceKeys.length * Math.random())];
        target.ship.devices[critdv as keyof typeof target.ship.devices] += hita;
        if (critdv === "shield") {
            target.ship.shieldsUp = false;
        }
        critdm = hita;
        hita += (Math.random() - 0.5) * 1000.0;
        addPendingMessage(target, `${critdv} damaged (${Math.round(hita)})!`);
    }

    // Damage application (labels 500, 600)
    if (target instanceof Player) {
        if (!target.ship) return null;
        target.ship.damage += hita;
        target.ship.energy -= hita;
        if (target.ship.shieldEnergy <= 0) {
            target.ship.shieldsUp = false;
        }
    } else if (target instanceof Planet && target.isBase) {
        target.energy = Math.max(0, Math.floor(target.energy - hita * 0.01));
    }

    // Scoring (label 700)
    const sourceSide = source instanceof Player ? source.ship && source.ship.side : source.side;
    const targetSide = target instanceof Player ? target.ship && target.ship.side : target.side;
    const PLAYER = source instanceof Player;
    const SHIP = target instanceof Player;
    if (SHIP && PLAYER && sourceSide === 'FEDERATION' && targetSide === 'EMPIRE') {
        if (sourceSide) {
            pointsManager.addDamageToBases(hita, source, sourceSide);
        }
    }
    if (SHIP && !PLAYER && target instanceof Planet && target.isBase) {
        if (sourceSide) {
            pointsManager.addDamageToBases(hita, undefined, sourceSide);
        }
    }
    if (PLAYER && SHIP && sourceSide === 'EMPIRE' && targetSide === 'FEDERATION') {
        if (sourceSide) {
            pointsManager.addDamageToEnemies(hita, source, sourceSide);
        }
    }
    if (SHIP && !PLAYER && target instanceof Player && sourceSide !== targetSide) {
        if (sourceSide) {
            pointsManager.addDamageToEnemies(hita, undefined, sourceSide);
        }
    }

    // Destruction and shield state (labels 700, 1300)
    if (target instanceof Player) {
        if (!target.ship) return null;
        shieldStrength = target.ship.shieldEnergy;
        shieldsUp = target.ship.shieldsUp;
        if (target.ship.damage >= 2500 || target.ship.energy <= 0) {
            isDestroyed = true;
            addPendingMessage(target, `Your ship has been destroyed by ${source instanceof Player ? source.ship?.name : source.side}!`);
            removePlayerFromGame(target);
            if (PLAYER && SHIP && sourceSide !== targetSide) {
                if (sourceSide) {
                    pointsManager.addEnemiesDestroyed(1, source, sourceSide);
                }
            }
            if (SHIP && !PLAYER && sourceSide !== targetSide) {
                if (sourceSide) {
                    pointsManager.addEnemiesDestroyed(1, undefined, sourceSide);
                }
            }
        }
    } else if (target instanceof Planet && target.isBase) {
        shieldStrength = target.energy;
        shieldsUp = true; // Bases always have shields up
        if (target.energy <= 0 || ((Math.floor(Math.random() * 10) + 1) === 10 && target.energy <= 50)) {
            isDestroyed = true;
            target.energy = Math.max(0, target.energy - (50 + 100 * Math.random()));
            target.isBase = false;
            const baseArray = target.side === 'FEDERATION' ? bases.federation : bases.empire;
            const idx = baseArray.indexOf(target);
            if (idx !== -1) {
                baseArray.splice(idx, 1);
            }
            if (SHIP && !PLAYER) {
                if (sourceSide) {
                    pointsManager.addDamageToBases(10000, undefined, sourceSide);
                }
            }
            if (SHIP && PLAYER) {
                if (sourceSide) {
                    pointsManager.addDamageToBases(10000, source, sourceSide);
                }
            }
            //addPendingMessage(null, `${target.side} starbase at ${target.position.v}-${target.position.h} destroyed!`);
        }
    }

    return { hita, isDestroyed, shieldStrength, shieldsUp, critdm };
}

export function calculateAndApplyPhaserDamage(
    source: Player | Planet,
    target: Player | Planet,
    phit: number
): { hita: number; isDestroyed: boolean; shieldStrength: number; shieldsUp: boolean; critdm: number } {
    console.log(`[PHADAM] Starting with phit=${phit}`);

    // Step 1: Initialization (PHADAM lines 69–73)
    let hita = phit;
    let hit = 0.0;
    let powfac = 8; // Line 70 (removed 10x)
    let rana = Math.random(); // Line 71
    let critdm = 0;
    let klflg = false;

    if (source instanceof Player && source.ship && source.ship.shieldsUp) {
        powfac = powfac / 2;
    }
    if (target instanceof Planet && target.isBase) {
        powfac = powfac / 2;
    }

    // DAMAGE CALCULATION
    const dist = chebyshev(
        source instanceof Player && source.ship ? source.ship.position : (source as Planet).position,
        target instanceof Player && target.ship ? target.ship.position : (target as Planet).position
    );

    console.log(`[PHADAM Step 1] Distance: ${dist}`);

    hit = Math.pow(0.9 + 0.02 * Math.random(), dist);   //hit = pwr ((0.9 + 0.02 * ran(0)), id)

    if (source instanceof Player && source.ship && source.ship.devices.computer > 0) {   // player firing and damage penalty
        hit = hit * 0.8;
    }

    console.log(`[PHADAM Step 1] Hit: ${hit}`);


    // SHIELD ABSORPTION

    if (target instanceof Player && target.ship && target.ship.shieldsUp) {  // player->player shields up
        // hita = hit
        // hit = (1000 - shpcon(j,KSSHPC)) * hita * 0.001
        // shpcon(j,KSSHPC) = shpcon(j,KSSHPC) - (hita * powfac * phit * 
        //  +	amax1 (float(shpcon(j,KSSHPC)) * 0.001, 0.1) + 10) * 0.03
        hita = hit;
        hit = (100 - (target.ship.shieldEnergy / MAX_SHIELD_ENERGY)) * hita * 0.01; //(removed 10x)
        console.log(`[PHADAM Step 2a]  after shield %: ${hit}`);

        target.ship.shieldEnergy -= (hita * powfac * phit * Math.max(target.ship.shieldEnergy * 0.01, 0.1) + 1) * 0.03;
        target.ship.shieldEnergy = Math.max(0, target.ship.shieldEnergy);
        hita = hit * powfac * phit

    } else if (target instanceof Player && target.ship && !target.ship.shieldsUp) {// player->player shields down
        hita = hit * powfac * phit

    } else if (target instanceof Planet && target.isBase) {  // player -> base  
        hita = hit;
        hit = (100 - target.energy) * hita * 0.01;
        target.energy -= (hita * powfac * phit * (Math.max(target.energy * 0.001, 0.1) + 10) * 0.03);
    }





    // common criticl hit code

    let ihita = hita;


    if (target instanceof Player && ((hita * (rana + 0.1)) >= 1700.0)) {
        // SHIP CRITICAL HIT
        // hita = hita / 2.0
        // critdv = int (KNDEV * ran(0) + 1.0)		!pick a device
        // shpdam(j,critdv) = shpdam(j,critdv) + hita	!and damage it
        // if (critdv .eq. KDSHLD)  shpcon(j,KSHCON) = -1	!shields down?
        // critdm = hita
        // hita = hita + (ran(0) - 0.5) * 1000.0
        // ihita = hita

        if (!target.ship) return { hita: 0, isDestroyed: false, shieldStrength: 0, shieldsUp: false, critdm: 0 };
        hita = hita / 2.0;
        const deviceKeys = Object.keys(target.ship.devices);
        let critdv = deviceKeys[Math.floor(deviceKeys.length * Math.random())];
        target.ship.devices[critdv as keyof typeof target.ship.devices] += hita;
        if (critdv === "shield") {
            target.ship.shieldsUp = false;
        }
        critdm = hita;
        hita += (Math.random() - 0.5) * 1000.0;
        ihita = hita;
    }

    if (target instanceof Player && target.ship) {
        target.ship.damage += hita;
        target.ship.energy -= hita;
    }
    console.log(`hitta: ${hita}`);
    if (target instanceof Planet && target.isBase) {
        //base(j,3,nplc-2) = max0 (int(base(j,3,nplc-2) - hita * 0.01), 0)
        target.energy = Math.max(0, Math.floor(target.energy - (hita * 0.01)));
    }

    if (target instanceof Player && target.ship) {
        if (target.ship.shieldEnergy <= 0) {
            target.ship.shieldsUp = false;
        }
    }

    // critical base hit
    if (target instanceof Planet && target.isBase && ((hita * (rana + 0.1)) >= 1700.0)) {
        if (Math.random() < 0.2) {
            //critical base hit
            target.energy = - 50 - (100.0 * Math.random());
            critdm = 1
            //if ((iran(10) .eq. 10) .or. (base(j,3,nplc-2) .le. 0)) klflg = 2:
            if (Math.random() == 10 || target.energy <= 0) {
                klflg = true;
            }
            //shstto = base(j,3,nplc-2) ; shcnto = 1:
            //shstto = target.energy;
            if (klflg) {
                // kill base
                target.energy = 0;
                target.isBase = false;
                // Remove this base from the correct bases array
                // Remove the destroyed base from the correct array based on its side
                let sideBases = target.side === "FEDERATION" ? bases.federation : bases.empire;
                const idx = sideBases.indexOf(target);
                if (idx !== -1) {
                    sideBases.splice(idx, 1);
                }
                //checkEndGame();
            }
        }
    }


    // // Step 2: Validation (TORDAM lines 7–8)
    // let initialShieldEnergy = 0;
    // let initialEnergy = 0;
    // let initialShieldsUp = false;
    // if (target instanceof Player) {
    //     if (!target.ship || target.ship.damage >= KENDAM || target.ship.energy <= 0) {
    //         console.log(`[PHADAM Step 2] Ship target invalid: damage=${target.ship?.damage}, energy=${target.ship?.energy}`);
    //         return { hita: 0, isDestroyed: false, shieldStrength: 0, shieldsUp: false, critdm: 0 };
    //     }
    //     initialShieldEnergy = target.ship.shieldEnergy;
    //     initialEnergy = target.ship.energy;
    //     initialShieldsUp = target.ship.shieldsUp;
    //     target.ship.shieldEnergy = Math.min(Math.max(target.ship.shieldEnergy, 0), MAX_SHIELD_ENERGY);
    //     console.log(`[PHADAM Step 2] Ship target valid: initialShieldEnergy=${initialShieldEnergy}, clampedShieldEnergy=${target.ship.shieldEnergy}, initialEnergy=${initialEnergy}, shieldsUp=${initialShieldsUp}`);
    // } else if (target instanceof Planet) {
    //     if (!target.isBase || target.energy <= 0) {
    //         console.log(`[PHADAM Step 2] Base target invalid: isBase=${target.isBase}, energy=${target.energy}`);
    //         return { hita: 0, isDestroyed: false, shieldStrength: 0, shieldsUp: false, critdm: 0 };
    //     }
    //     initialShieldEnergy = target.energy;
    //     target.energy = Math.min(Math.max(target.energy, 0), DEFAULT_BASE_ENERGY);
    //     console.log(`[PHADAM Step 2] Base target valid: initialEnergy=${initialShieldEnergy}, clampedEnergy=${target.energy}`);
    // } else {
    //     console.log(`[PHADAM Step 2] Invalid target type`);
    //     return { hita: 0, isDestroyed: false, shieldStrength: 0, shieldsUp: false, critdm: 0 };
    // }

    // // Step 3: Distance (PHADAM line 81)
    // const distance = chebyshev(
    //     source instanceof Player && source.ship ? source.ship.position : (source as Planet).position,
    //     target instanceof Player && target.ship ? target.ship.position : (target as Planet).position
    // );
    // console.log(`[PHADAM Step 3] Distance calculated: distance=${distance}`);

    // // Step 4: Power factor (PHADAM lines 74–76)
    // const initialPowfac = powfac;
    // if (target instanceof Player && target.ship && target.ship.shieldsUp) {
    //     powfac /= 2; // 40, line 74
    //     console.log(`[PHADAM Step 4] Shields up, powfac halved: ${initialPowfac} -> ${powfac}`);
    // }
    // if (target instanceof Planet && target.isBase) {
    //     powfac /= 2; // 40 or 20, line 76
    //     console.log(`[PHADAM Step 4] Base target, powfac halved: ${initialPowfac} -> ${powfac}`);
    // }
    // console.log(`[PHADAM Step 4] Final powfac: ${powfac}`);

    // // Step 5: Base hit (PHADAM line 77)
    // const randomFactor = 0.9 + 0.02 * Math.random();
    // hit = Math.pow(randomFactor, distance);
    // console.log(`[PHADAM Step 5] Base hit: randomFactor=${randomFactor}, distance=${distance}, hit=${hit}`);

    // // Step 6: Source damage penalty (PHADAM lines 78–80)
    // const PLAYER = source instanceof Player;
    // const SHIP = target instanceof Player;
    // if (PLAYER && SHIP && source instanceof Player && source.ship &&
    //     (source.ship.devices.phaser > 0 || source.ship.devices.computer > 0)) {
    //     const initialHit = hit;
    //     hit *= 0.8;
    //     console.log(`[PHADAM Step 6] Source phaser/computer damaged, hit reduced: ${initialHit} -> ${hit}`);
    // }
    // console.log(`[PHADAM Step 6] Final hit after penalty: ${hit}`);

    // // Step 7: Clamp energy (inferred from phasrs)
    // //let phit = energy;
    // if (source instanceof Player && source.ship) {
    //     const initialPhit = phit;
    //     phit = Math.min(phit, source.ship.energy);
    //     console.log(`[PHADAM Step 7] Energy clamped: initialPhit=${initialPhit}, sourceEnergy=${source.ship.energy}, phit=${phit}`);
    // }
    // console.log(`[PHADAM Step 7] Final phit: ${phit}`);

    // // Step 8: Ship target (PHADAM lines 81–87)
    // if (target instanceof Player && target.ship) {
    //     const shieldFactor = Math.max(target.ship.shieldEnergy * 0.001 * (1000 / MAX_SHIELD_ENERGY), 0.1);
    //     console.log(`[PHADAM Step 8] Ship target: shieldsUp=${target.ship.shieldsUp}, shieldEnergy=${target.ship.shieldEnergy}, shieldFactor=${shieldFactor}`);
    //     if (!target.ship.shieldsUp) {
    //         hita = hit * powfac * phit; // Line 87
    //         console.log(`[PHADAM Step 8a] Shields down: hita = hit(${hit}) * powfac(${powfac}) * phit(${phit}) = ${hita}`);
    //     } else {
    //         hita = hit; // Line 83
    //         console.log(`[PHADAM Step 8b] Shields up, initial hita = hit: ${hita}`);
    //         const scaledShieldEnergy = target.ship.shieldEnergy * (1000 / MAX_SHIELD_ENERGY);
    //         hit = (1000 - scaledShieldEnergy) * hita * 0.001; // Line 84
    //         console.log(`[PHADAM Step 8c] Shield reduction: scaledShieldEnergy=${scaledShieldEnergy}, hit = (1000 - ${scaledShieldEnergy}) * hita(${hita}) * 0.001 = ${hit}`);
    //         const shieldDepletion = (hita * powfac * phit * shieldFactor + 10) * 0.03;
    //         target.ship.shieldEnergy = Math.max(0, target.ship.shieldEnergy - shieldDepletion); // Line 85
    //         console.log(`[PHADAM Step 8d] Shield depletion: (hita(${hita}) * powfac(${powfac}) * phit(${phit}) * shieldFactor(${shieldFactor}) + 10) * 0.03 = ${shieldDepletion}, newShieldEnergy=${target.ship.shieldEnergy}`);
    //         if (target.ship.shieldEnergy <= 0) {
    //             target.ship.shieldEnergy = 0; // Line 86
    //             console.log(`[PHADAM Step 8e] ShieldEnergy <= 0, clamped to 0`);
    //         }
    //         hita = hit * powfac * phit; // Line 87
    //         console.log(`[PHADAM Step 8f] Final hita: hit(${hit}) * powfac(${powfac}) * phit(${phit}) = ${hita}`);
    //     }
    //     console.log(`[PHADAM Step 8] Result: hita=${hita}, shieldEnergy=${target.ship.shieldEnergy}, shieldsUp=${target.ship.shieldsUp}`);
    //     addPendingMessage(target, `${source instanceof Player && source.ship ? source.ship.name : (source as Planet).side} hits your ship for ${Math.round(hita)} damage!`);
    // }
    // // Step 9: Base target (PHADAM lines 88–91)
    // else if (target instanceof Planet && target.isBase) {
    //     const shieldFactor = Math.max(target.energy * 0.001 * (1000 / DEFAULT_BASE_ENERGY), 0.1);
    //     console.log(`[PHADAM Step 9] Base target: energy=${target.energy}, shieldFactor=${shieldFactor}`);
    //     hita = hit; // Line 89
    //     console.log(`[PHADAM Step 9a] Initial hita = hit: ${hita}`);
    //     const scaledEnergy = target.energy * (1000 / DEFAULT_BASE_ENERGY);
    //     hit = (1000 - scaledEnergy) * hita * 0.001; // Line 90
    //     console.log(`[PHADAM Step 9b] Shield reduction: scaledEnergy=${scaledEnergy}, hit = (1000 - ${scaledEnergy}) * hita(${hita}) * 0.001 = ${hit}`);
    //     const energyDepletion = (hita * powfac * phit * shieldFactor + 10) * 0.03;
    //     target.energy = Math.max(0, target.energy - energyDepletion); // Line 91
    //     console.log(`[PHADAM Step 9c] Energy depletion: (hita(${hita}) * powfac(${powfac}) * phit(${phit}) * shieldFactor(${shieldFactor}) + 10) * 0.03 = ${energyDepletion}, newEnergy=${target.energy}`);
    //     hita = hit * powfac * phit; // Line 87 (via 800)
    //     console.log(`[PHADAM Step 9d] Final hita: hit(${hit}) * powfac(${powfac}) * phit(${phit}) = ${hita}`);
    //     console.log(`[PHADAM Step 9] Result: hita=${hita}, baseEnergy=${target.energy}`);
    //     const message = `${source instanceof Player && source.ship ? source.ship.name : (source as Planet).side} hits ${target.side} starbase at ${target.position.v}-${target.position.h} for ${Math.round(hita)} damage!`;
    //     if (source instanceof Player) {
    //         addPendingMessage(source, message);
    //     }
    // }

    // Step 10: Call applyDamage
    console.log(`[PHADAM Step 10] Calling applyDamage with hita=${hita}, rana=${rana}`);
    const result = applyDamage(source, target, hita, rana);
    //console.log(`[PHADAM Step 10] applyDamage result: hita=${result.hita}, isDestroyed=${result.isDestroyed}, shieldStrength=${result.shieldStrength}, shieldsUp=${result.shieldsUp}, critdm=${result.critdm}`);
    return result || { hita: 0, isDestroyed: false, shieldStrength: 0, shieldsUp: false, critdm: 0 };
}


// This routine, along with it's entry point PHADAM, determines
// C	the amount of damage inflicted on ships and bases by torpedo
// C	and phaser hits.  It also updates the scoring information, and
// C	sets up many of the variables eventually needed by MAKHIT.
// 	subroutine TORDAM (nplc, j, id, phit, ship)
// 	include 'param/nolist'
// 	include 'hiseg/nolist'
// 	include 'lowseg/nolist'
// 	include 'extern/nolist'
// 	real rand, rana, hit, ranb, hita
// *.......Has the target already been destroyed?
// 	if ((nplc .lt. DXFBAS) .and. ((shpcon(j,KSDAM) .ge. KENDAM) 
//      +	.or. (shpcon(j,KSNRGY) .le. 0)))  return
// 	if ((nplc .ge. DXFBAS) .and. (base(j,3,nplc-2) .le. 0))  return
// 	iwhat = 2
// 	rand = ran(0)
// 	rana = ran(0)
// 	hit  = 0.0
// 	hita = 0.0
// 	ranb = rand - 0.5
// *.......Determine size of hit and amount absorbed by shields (if up)
// *.......Reduce shield energy due to attack
// 	hit = 4000.0 + 4000.0 * ran(0)
// 	if (nplc .ge. DXFBAS)  goto 1100
// 	if (shpcon(j,KSHCON) .gt. 0)  1000, 300
//  100	if (nplc .ge. DXFBAS)  goto 200
// 	hita = hit * (1000.0 - shpcon(j,KSSHPC)) * 0.001
// 	shpcon(j,KSSHPC) = shpcon(j,KSSHPC) - 
//      +	(hit * amax1 (float(shpcon(j,KSSHPC)) * 0.001, 0.1)
//      +  + 10) * 0.03
// 	if (shpcon(j, ksshpc) .lt. 0) shpcon(j, ksshpc) = 0
// 	goto 300
//  200	hita = hit * (1000 - base(j,3,nplc-2)) * 0.001
// 	base(j,3,nplc-2) = base(j,3,nplc-2) - 
//      +  (hit * amax1(float(base(j,3,nplc-2)) * 0.001, 0.1) + 10) * 0.03
// 	goto 400

// import { NullSocket } from './util/nullsocket.js';

// function testing() {
//     const player: Player = new Player(new NullSocket());
//     player.ship = new Ship(player);
//     player.ship.shieldEnergy = 2500;
//     player.ship.shieldsUp = false;
//     player.ship.position = { v: 10, h: 10 };

//     const target: Player = new Player(new NullSocket());
//     target.ship = new Ship(target);
//     target.ship.shieldEnergy = 1500;
//     target.ship.shieldsUp = false;
//     target.ship.position = { v: 11, h: 10 };
//     calcShipPhaserDamage(200, player, target);
// }



function calcShipPhaserDamage(phit: number, player: Player, target: Player) {
    let powfac = 8;
    let rana = Math.random();
    let hit = 0.0;
    let hita = 0.0;

    if (!player.ship) return;
    if (!target.ship) return;

    if (player.ship.shieldsUp) {
        powfac = powfac / 2;
    }

    const dist = chebyshev(player.ship.position, target.ship.position);

    hit = Math.pow(0.9 + 0.02 * Math.random(), dist);

    if (player.ship.devices.computer > 0 || player.ship.devices.phaser > 0) {
        hit = hit * 0.8;
    }

    if (target.ship.shieldsUp) {
        hita = hit;
        hit = (1 - target.ship.shieldEnergy / MAX_SHIELD_ENERGY) * hita;

        target.ship.shieldEnergy -= (hita * powfac * phit * Math.max(target.ship.shieldEnergy / MAX_SHIELD_ENERGY, 0.1) + 10) * 0.3;  //????

        let val = (hita * powfac * phit * Math.max(target.ship.shieldEnergy / MAX_SHIELD_ENERGY, 0.1) + 1) * 0.3;

        target.ship.shieldEnergy = Math.max(0, target.ship.shieldEnergy);
        if (target.ship.shieldEnergy <= 0) {
            target.ship.shieldEnergy = 0;
        }
    }

    hita = hit * powfac * phit;
    isCritical(hita, rana, player, target);
}


export function calcBasePhaserDamage(phit: number, player: Player, target: Planet) {
    let powfac = 4;
    let rana = Math.random();
    let hit = 0.0;
    let hita = 0.0;

    if (!player.ship) return;
    if (!target.isBase) return;

    const dist = chebyshev(player.ship.position, target.position);

    hit = Math.pow(0.9 + 0.02 * Math.random(), dist);

    hita = hit;
    hit = (1 - target.energy / DEFAULT_BASE_ENERGY) * hita;

    target.energy -= (hita * powfac * phit
        * Math.max(target.energy / MAX_SHIELD_ENERGY, 0.1) + 1) * 0.3;  //????

    let val = (hita * powfac * phit * Math.max(target.energy / MAX_SHIELD_ENERGY, 0.1) + 1) * 0.3;

    hita = hit * powfac * phit;
    isCritical(hita, rana, player, target);
}

function isCritical(hita: number, rana: number, player: Player, target: Player | Planet) {
    let ihita = hita;
    if ((hita * (rana + 0.1) < 170) && target instanceof Player && target.ship) { //500
        target.ship.damage += hita;
        target.ship.energy -= hita;
        console.log("Ship  hita no div 2", hita);
    } else if ((hita * (rana + 0.1) < 170) && target instanceof Planet && target.isBase) { // 600
        target.energy = Math.max(0, Math.floor(target.energy - (hita * 0.01)));
    } else if (Math.floor(Math.random() * 10) === 10 && target instanceof Planet && target.isBase) { // 1400
        target.energy = target.energy - 50 - Math.floor(100.0 * Math.random());
        let critdm = 1;
        // Example: 10% chance for "kill" (can adjust as needed)
        if (Math.floor(Math.random() * 10) === 0 || target.energy <= 0) {
            //kill
            let sideBases = target.side === "FEDERATION" ? bases.federation : bases.empire;
            const idx = sideBases.indexOf(target);
            if (idx !== -1) {
                sideBases.splice(idx, 1);
            }
        }
        // if (SHIP.and. .not.PLAYER) rsr(KPBDAM) = rsr(KPBDAM) + 10000  TODO
        // if (SHIP.and.PLAYER) tpoint(KPBDAM) = tpoint(KPBDAM) + 10000

    } else if (target instanceof Planet && target.isBase) { // 600
        target.energy = Math.max(0, Math.floor(target.energy - (hita * 0.01)));
    } else {
        if (!(target instanceof Player) || !target.ship) return;
        hita = hita / 2.0;
        const deviceKeys = Object.keys(target.ship.devices);
        let critdv = deviceKeys[Math.floor(deviceKeys.length * Math.random())];
        target.ship.devices[critdv as keyof typeof target.ship.devices] += hita;
        console.log("critdv loses ", hita);
        if (critdv === "shield") {
            target.ship.shieldsUp = false;
        }

        console.log("critdm  to ship", hita);
        hita = hita + (Math.random() - 0.5) * 100.0; // reduced to 100
        console.log("Ship  hita 2 ", hita);

        ihita = hita;
        target.ship.damage += hita;
        target.ship.energy -= hita;
        console.log("Ship  hita 3 ", hita);
    }
    if (target instanceof Player && target.ship && target.ship.shieldEnergy <= 0) {
        target.ship.shieldsUp = false;
    }

    if (target instanceof Player && target.ship && player.ship) { // SHIP TO SHIP   
        let pshield = player.ship.shieldEnergy / MAX_SHIELD_ENERGY * 100;
        let tshield = target.ship.shieldEnergy / MAX_SHIELD_ENERGY * 100;
        let psign = player.ship.shieldsUp ? "+" : "-";
        let tsign = target.ship.shieldsUp ? "+" : "-";
        let tcoord = ocdefCoords(player.settings.ocdef, player.ship.position, target.ship.position);
        let output = '';


        switch (player.settings.output) {
            case "MEDIUM":
                output = `${player.ship.name[0]} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}%  +${hita.toFixed(1)} unit P ${target.ship.name[0]} @${tcoord}, ${tsign}${tshield.toFixed(1)}%`;
                break;
            case "SHORT":
                output = `${player.ship.name[0]} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}  +${hita.toFixed(1)} unit P ${target.ship.name[0]} @${tcoord}, ${tsign}${tshield.toFixed(1)}`;
                break;
            default:
                output = `${player.ship.name} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}%  +${hita.toFixed(1)} unit phaser hit on ${target.ship.name} @${tcoord}, ${tsign}${tshield.toFixed(1)}%`;
                break;
        }

        sendMessageToClient(player, output);
        switch (player.settings.output) {
            case "MEDIUM":
                output = `${player.ship.name[0]} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}%  +${hita.toFixed(1)} unit P ${target.ship.name[0]} @${target.ship.position.v}-${target.ship.position.h}, ${tsign}${tshield.toFixed(1)}%`;
                break;
            case "SHORT":
                output = `${player.ship.name[0]} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}  +${hita.toFixed(1)} unit P ${target.ship.name[0]} @${target.ship.position.v}-${target.ship.position.h}, ${tsign}${tshield.toFixed(1)}`;
                break;
            default:
                output = `${player.ship.name} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}%  +${hita.toFixed(1)} unit phaser hit on ${target.ship.name} @${target.ship.position.v}-${target.ship.position.h}, ${tsign}${tshield.toFixed(1)}%`;
                break;
        }
        //addPendingMessage(target, output);  done with sendMessageToOthers
        sendMessageToOthers(player, output, 10);
    } else if (player instanceof Player && player.ship && target instanceof Planet && target.isBase) { // SHIP TO BASE
        let pshield = player.ship.shieldEnergy / MAX_SHIELD_ENERGY * 100;
        let tshield = target.energy / DEFAULT_BASE_ENERGY * 100;
        let psign = player.ship.shieldsUp ? "+" : "-";
        let tsign = tshield > 0 ? "+" : "-";
        let tcoord = ocdefCoords(player.settings.ocdef, player.ship.position, target.position);
        let output = '';

        switch (player.settings.output) {
            case "MEDIUM":
                output = `${player.ship.name} Ship @${player.ship?.position.v}-${player.ship?.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}%  +${hita.toFixed(1)} unit phaser hit on ${target.side} Base @${target.position.v}-${target.position.h}, ${tsign}${tshield.toFixed(1)}%`;
                break;
            case "SHORT":
                output = `${player.ship.name[0]} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}  +${hita.toFixed(1)} unit P ${target.side} Base @${target.position.v}-${target.position.h}, ${tsign}${tshield.toFixed(1)}`;
                break;
            default:
                output = `${player.ship.name} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}%  +${hita.toFixed(1)} unit phaser hit on ${target.side} Base @${target.position.v}-${target.position.h}, ${tsign}${tshield.toFixed(1)}%`;
                break;
        }
        sendMessageToClient(player, output);
        switch (player.settings.output) {
            case "MEDIUM":
                output = `${player.ship.name} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}%  +${hita.toFixed(1)} unit phaser hit on ${target.side} Base @${target.position.v}-${target.position.h}, ${tsign}${tshield.toFixed(1)}%`;
                break;
            case "SHORT":
                output = `${player.ship.name[0]} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}  +${hita.toFixed(1)} unit P ${target.side} Base@${target.position.v}-${target.position.h}, ${tsign}${tshield.toFixed(1)}`;
                break;
            default:
                output = `${player.ship.name} Ship @${player.ship.position.v}-${player.ship.position.h}, `;
                output += `${psign}${pshield.toFixed(1)}%  +${hita.toFixed(1)} unit phaser hit on ${target.side} Base @${target.position.v}-${target.position.h}, ${tsign}${tshield.toFixed(1)}%`;
                break;
        }
        sendMessageToOthers(player, output, 10);

    } else if (player instanceof Planet && target instanceof Player && target.ship) { // BASE to SHIP
        let tshield = target.ship.shieldEnergy / MAX_SHIELD_ENERGY * 100;
        let pshield = player.energy / DEFAULT_BASE_ENERGY * 100;
        let tsign = target.ship.shieldsUp ? "+" : "-";
        let psign = player.energy > 0 ? "+" : "-";
        let output = '';
        //Neu planet @58-64 0,-2 makes 0.0 unit phaser hit on Lexington @58-66, +95.0%
        sendMessageToClient(player, "#{player.side} planet @${player.position.v}-${player.position.h} makes ${hita.toFixed(1)} unit phaser hit on ${target.ship.name} @${target.ship.position.v}-${target.ship.position.h}, ${psign}${pshield.toFixed(1)}%");
    }
}
function phaserScoring(hita: number, player: Player, target: Player | Planet) {
    // if (SHIP.and.PLAYER.and. (5 - team.eq.nplc))
    //     +	tpoint(KPBDAM) = tpoint(KPBDAM) + hita
    // if (SHIP.and. (.not.PLAYER).and. (nplc.ge.DXFBAS))
    //     +	rsr(KPBDAM) = rsr(KPBDAM) + hita
    // if (PLAYER.and.SHIP.and. (3 - team.eq.nplc))
    //     +	tpoint(KPEDAM) = tpoint(KPEDAM) + hita
    // if (SHIP.and. (.not.PLAYER).and. (nplc.lt.DXFBAS))
    //     +	rsr(KPEDAM) = rsr(KPEDAM) + hita

    // if (nplc.ge.DXFBAS)  goto 1300!base ?
    //     shpcon(j, KSPCON) = RED
    //    shstto = shpcon(j, KSSHPC); shcnto = shpcon(j, KSHCON)
    // if ((shpcon(j, KSDAM).ge.KENDAM).or.
    //     + (shpcon(j, KSNRGY).le. 0)) klflg = 2

    // if (klflg.ne. 0)  goto 750!player destroyed ?
    //    if (iwhat.eq. 1) return !phaser hit ?
    //     call jump(nplc, j)!displaced by torp ?
    //    if (klflg.eq. 0) return !displaced into BH ?

    //     750	call setdsp(shpcon(j, KVPOS), shpcon(j, KHPOS), 0)
    // alive(j) = 0
    // if (PLAYER.and.SHIP) tpoint(KPEKIL) = tpoint(KPEKIL) + 5000
    // if (SHIP.and. .not.PLAYER) rsr(KPEKIL) = rsr(KPEKIL) + 5000
    // return

    //    entry PHADAM(nplc, j, id, phit, ship)
}



// 700	if ((nplc .lt. DXFBAS) .and. (shpcon(j,KSSHPC) .le. 0)) 
//  +	shpcon(j,KSHCON) = -1