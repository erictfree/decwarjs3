// Classic DECWAR-style PHASER (PH) command implementation
import { Player } from './player.js';
import { Command } from './command.js';
import {
    DESTRUCTION_DAMAGE_THRESHOLD,
    PHASER_COOLDOWN,
    OutputSetting
} from './settings.js';
import { sendMessageToClient, addPendingMessage } from './communication.js';
import { chebyshev, ocdefCoords, getCoordsFromCommandArgs } from './coords.js';
import { Planet } from './planet.js';
import { players, planets, bases } from './game.js';

export function phaserCommand(player: Player, command: Command): void {
    if (!player.ship) {
        sendMessageToClient(player, "You cannot fire phasers — you have no ship.");
        return;
    }

    let args = command.args;
    const now = Date.now();
    const [ph1, ph2] = player.ship.cooldowns.phasersAvailableAt;
    const bankIndex = ph1 <= ph2 ? 0 : 1;
    let energy = 200;  // default energy

    // if (!requireDevices(player, ["phaser"])) return;  TODO: add this back in

    if (now < player.ship.cooldowns.phasersAvailableAt[bankIndex]) {
        switch (player.settings.output) {
            case "SHORT":
                sendMessageToClient(player, "PH > RCHG");
                break;
            case "MEDIUM":
                sendMessageToClient(player, "Phasers unavailable — recharging.");
                break;
            case "LONG":
            default:
                sendMessageToClient(player, "Both phaser banks are currently recharging.");
                break;
        }

        return;
    }

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

    energy = Math.min(Math.max(energy, 50), 500); // Clamp 50–500

    if (player.ship.energy < energy) {
        const e = player.ship.energy.toFixed(1);
        switch (player.settings.output) {
            case "SHORT":
                sendMessageToClient(player, `PH > NO E ${e}`);
                break;
            case "MEDIUM":
                sendMessageToClient(player, `Insufficient energy: ${e}`);
                break;
            case "LONG":
            default:
                sendMessageToClient(player, `Insufficient energy to fire phasers. Available energy: ${e}`);
                break;
        }
        return;
    }
    const { position: { v: targetV, h: targetH } } =
        getCoordsFromCommandArgs(player, args, player.ship.position.v, player.ship.position.h, true);

    const distance = chebyshev(player.ship.position, { v: targetV, h: targetH });

    if (distance > 10) {
        switch (player.settings.output) {
            case "SHORT":
                sendMessageToClient(player, "PH > RANGE");
                break;
            case "MEDIUM":
                sendMessageToClient(player, "Target exceeds phaser range.");
                break;
            case "LONG":
            default:
                sendMessageToClient(player, "Target out of phaser range (maximum 10 sectors).");
                break;
        }
        return;
    }

    // Auto shield toggle penalty
    if (player.ship.shieldsUp && player.ship.level > 0) {
        energy += 200;
        sendMessageToClient(player, "High-speed shield cycling used (extra 200 energy).");
    }

    // Apply energy cost
    player.ship.energy = Math.max(0, player.ship.energy - energy);

    // RED ALERT: firing phasers triggers red alert
    player.ship.condition = "RED";

    // Find target
    const target =
        players.find(p => p.ship && p.ship.position.h === targetH && p.ship.position.v === targetV) ||
        planets.find(p => p.position.h === targetH && p.position.v === targetV);

    if (!target) {
        switch (player.settings.output) {
            case "SHORT":
                sendMessageToClient(player, "PH > MISS");
                break;
            case "MEDIUM":
                sendMessageToClient(player, "No target present.");
                break;
            case "LONG":
            default:
                sendMessageToClient(player, "No valid target at that location for phaser strike.");
                break;
        }

        return;
    }

    const targetSide = "side" in target ? target.side : target.ship?.side;
    if (targetSide === player.ship.side) {
        sendMessageToClient(player, "Cannot fire phasers at a friendly target.");
        return;
    }

    // Compute effective damage
    let damage = energy * (1 - distance / 12); // closer = more damage

    if (target instanceof Player && target.ship && target.ship.shieldsUp) {
        damage *= 0.5;
    }

    if (player.ship.devices.phaser > 0 || player.ship.devices.computer > 0) {
        damage *= 0.8; // 20% penalty if damaged
    }

    // Apply damage
    if (target instanceof Player) {
        applyPhaserShipDamage(player, target, damage);
    } else if (target instanceof Planet) {
        if (target.isBase) {
            applyPhaserBaseDamage(player, target, damage);
        } else {
            if (target.builds > 0) {
                const dmgBuilds = Math.floor(damage / 200);
                target.builds = Math.max(0, target.builds - dmgBuilds);
                sendMessageToClient(player, formatPhaserPlanetHit(player, target));
            } else {
                switch (player.settings.output) {
                    case "SHORT":
                        sendMessageToClient(player, `PH > P NO EFFECT`);
                        break;
                    case "MEDIUM":
                        sendMessageToClient(player, `Phaser fire ineffective. No effect on planet.`);
                        break;
                    case "LONG":
                    default:
                        sendMessageToClient(player, `Phasers fired at planet, but no effect was observed. Planet has no remaining builds.`);
                        break;
                }
            }
        }
    }

    if (player.ship) {
        // Cooldown
        const damagePenalty = (player.ship.devices.phaser || 0) / 100;
        const cooldown = PHASER_COOLDOWN + Math.random() * PHASER_COOLDOWN + damagePenalty;
        player.ship.cooldowns.phasersAvailableAt[bankIndex] = now + cooldown;

        // Overheat check
        const overheatChance = energy / 7.7; // ~65% at 500

        if (Math.random() * 100 < overheatChance) {
            const overheatDamage = 300 + Math.random() * 600;
            player.ship.devices.phaser += overheatDamage;
            const dmg = Math.round(overheatDamage);
            switch (player.settings.output) {
                case "SHORT":
                    sendMessageToClient(player, `PH > OH ${dmg}`);
                    break;
                case "MEDIUM":
                    sendMessageToClient(player, `Phaser bank overheated (${dmg} dmg)`);
                    break;
                case "LONG":
                default:
                    sendMessageToClient(player, `Phaser bank overheated! ${dmg} damage sustained to internal systems.`);
                    break;
            }

        }

        if (player.ship.romulanStatus.isRomulan) {
            player.ship.romulanStatus.isRevealed = true;
            setTimeout(() => {
                if (player.ship)
                    player.ship.romulanStatus.isRevealed = false;
            }, 5000); // Cloak again after 5 seconds
        }
    }
}

export function applyPhaserBaseDamage(player: Player, target: Planet, damage: number): void {
    if (target.strength === 1000 && !target.hasCriedForHelp) {
        target.hasCriedForHelp = true;
        target.callForHelp(target.position.v, target.position.h, target.side);
    }

    // Apply damage
    target.strength = Math.max(0, target.strength - damage);

    // Send hit message using output level
    const formatted = formatPhaserBaseHit({
        player,
        base: target,
        damage
    });

    sendMessageToClient(player, formatted);

    // Destroy base if needed
    if (target.strength === 0) {
        const baseArray = target.side === "FEDERATION" ? bases.federation : bases.empire;
        const index = baseArray.indexOf(target);
        if (index !== -1) baseArray.splice(index, 1);

        sendMessageToClient(player, formatPhaserBaseDestroyed(player, target));

        //player.points.basesDestroyed += 1;  TODO: add this back in

    }
}

export function applyPhaserShipDamage(source: Player | Planet, target: Player, damage: number): void {
    if (source instanceof Player && !source.ship) {
        return;
    }
    if (!target.ship) {
        return;
    }
    const sourceType = source instanceof Player ? "Player" : "Planet";
    const sourceSide = source instanceof Player ? source.ship!.side : source.side;
    const sourcePos = source instanceof Player ? source.ship!.position : source.position;

    const targetSide = target.ship.side;
    const targetId = target.ship.name;
    const targetPos = target.ship.position;

    if (damage <= 0) {
        if (source instanceof Player) {
            const msg = `${sourceType} (${sourceSide}) at ${sourcePos} ` +
                `fires phasers at ${targetSide} ship ${targetId} at ${targetPos} ` +
                `but misses (distance=${chebyshev(sourcePos, targetPos)}`;

            sendMessageToClient(source, msg);
        }
        return;
    }

    let remainingDamage = damage;
    if (target.ship.level > 0) {
        const shieldAbsorbed = Math.min(target.ship.level, remainingDamage);
        target.ship.level -= shieldAbsorbed;
        remainingDamage -= shieldAbsorbed;
    }

    // Apply remaining damage to health
    if (remainingDamage > 0) {
        target.ship.energy = Math.max(0, target.ship.energy - remainingDamage);
    }

    // Update condition based on shield and health
    if (target.ship.level === 0 || target.ship.energy <= 200) {
        target.ship.condition = 'RED';
    } else if (target.ship.level <= 250 || target.ship.energy <= 500) {
        target.ship.condition = 'YELLOW';
    } else {
        target.ship.condition = 'GREEN';
    }

    // Get signed shield percentage (e.g. +83 or -72)
    const targetShieldPct = target.ship.computeShieldPercent();

    const sourceName: string =
        source instanceof Player && source.ship
            ? source.ship.name
            : source instanceof Planet
                ? "Planet"
                : "Unknown";

    // Format messages based on each player's output settings
    if (source instanceof Player) {
        const attackerMessage = formatPhaserHit({
            attacker: sourceName,
            target: target.ship.name ?? "Unknown",
            damage,
            attackerPos: sourcePos,
            targetShieldPercent: targetShieldPct,
            outputLevel: source.settings.output
        });

        sendMessageToClient(source, attackerMessage);
    }

    const targetMessage = formatPhaserHit({
        attacker: sourceName,
        target: target.ship.name ?? "Unknown",
        damage,
        attackerPos: sourcePos,
        targetShieldPercent: targetShieldPct,
        outputLevel: target.settings.output
    });

    addPendingMessage(target, targetMessage);

    sendFormattedMessageToObservers({
        origin: target.ship.position,
        attacker: sourceName,
        target: target.ship.name ?? "Unknown",
        damage,
        targetShieldPercent: targetShieldPct,
        formatFunc: formatPhaserHit
    });

    if (source instanceof Player) {
        if (target.ship.romulanStatus?.isRomulan) {
            source.points.damageToRomulans += damage;
        } else {
            source.points.damageToEnemies += damage;
        }
    }

    // Handle ship destruction
    if (target.ship.energy <= 0 || target.ship.damage >= DESTRUCTION_DAMAGE_THRESHOLD) {
        if (source instanceof Player) {
            sendMessageToClient(source, `${sourceName} destroyed ${targetSide} ship ${targetId} at ${targetPos} with phasers.`);
        }
        target.ship.isDestroyed = true;  //TODO: add this back in

        if (source instanceof Player) {
            // source.points.shipsDestroyed += 1;
            // if (target.ship.romulanStatus?.isRomulan) {  TODO
            //     source.points.romulansDestroyed += 1;
            // }
        }

        //addNewsItem(`${target.ship.name} destroyed by ${source.ship.name} via phasers.`);
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

// console.log(
//     `${sourceType} ${sourceId} (${sourceSide}) at ${sourcePos} ` +
//     `hits ${targetSide} ship ${targetId} at ${targetPos} ` +
//     `with phasers for ${damage} damage (distance=${distance}, prob=${prob})`
//   );
// } else {
//   console.log(
// Apply damage

export function formatPhaserBaseHit({
    player,
    base,
    damage
}: {
    player: Player;
    base: Planet;
    damage: number;
}): string {
    if (!player.ship) return "?, ?";//TODO
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

export function sendFormattedMessageToObservers({
    origin,
    attacker,
    target,
    damage,
    targetShieldPercent,
    formatFunc
}: {
    origin: { v: number; h: number };
    attacker: string;
    target: string;
    damage: number;
    targetShieldPercent: number;
    formatFunc: (opts: {
        attacker: string;
        target: string;
        damage: number;
        attackerPos: { v: number; h: number };
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

export function formatPhaserPlanetHit(player: Player, planet: Planet): string {
    if (!player.ship) return "?, ?"; //TODO
    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, planet.position);
    const name = player.ship.name;
    switch (player.settings.output) {
        case "SHORT":
            return `${name?.[0]} > P ${coords} ${planet.builds}B`;
        case "MEDIUM":
            return `${name} hit planet @${coords}, builds left: ${planet.builds}`;
        case "LONG":
        default:
            return `${name} fired phasers at planet located at ${coords}. Remaining builds: ${planet.builds}`;
    }
}

export function formatPhaserBaseDestroyed(player: Player, base: Planet): string {
    if (!player.ship) return "?, ?";  //TODO
    const coords = ocdefCoords(player.settings.ocdef, player.ship.position, base.position);
    const output = player.settings.output;
    switch (output) {
        case "SHORT":
            return `☠ ${base.side[0]}B ${coords}`;
        case "MEDIUM":
            return `${base.side} base destroyed at ${coords}`;
        case "LONG":
        default:
            return `The ${base.side} base at ${coords} has been destroyed!`;
    }
}