import { Player } from './player.js';
import { Command } from './command.js';
import {
    DESTRUCTION_DAMAGE_THRESHOLD,
    PHASER_COOLDOWN,
    OutputSetting,
    STARBASE_PHASER_RANGE
} from './settings.js';
import { sendMessageToClient, addPendingMessage } from './communication.js';
import { chebyshev, ocdefCoords, getCoordsFromCommandArgs } from './coords.js';
import { Planet } from './planet.js';
import { players, planets, bases, removePlayerFromGame, checkEndGame, pointsManager } from './game.js';

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
    const targetSide = "side" in target ? target.side : target.ship?.side;
    if (targetSide === player.ship.side) {
        sendMessageToClient(player, "Cannot fire phasers at a friendly target.");
        return;
    }

    let powfac = 80;
    if ((target instanceof Player && target.ship && target.ship.shieldsUp) || (target instanceof Planet && target.isBase)) powfac = 40;
    let baseHit = Math.pow(0.9 + 0.02 * Math.random(), distance);
    if (player.ship.devices.phaser > 0 || player.ship.devices.computer > 0) baseHit *= 0.8;

    if (target instanceof Player) {
        applyPhaserShipDamage(player, target, baseHit, powfac, energy / 500);
    } else if (target instanceof Planet) {
        applyPhaserBaseDamage(player, target, baseHit, powfac, energy / 500);
    }

    if (target instanceof Planet) {
        if (target.isBase) {
            applyPhaserBaseDamage(player, target, baseHit, powfac, energy / 500);
        } else {
            if (target.builds > 0 && Math.random() < 0.25) {
                target.builds = Math.max(0, target.builds - 1);
                sendMessageToClient(player, formatPhaserPlanetHit(player, target));
            } else {
                // No effect message
            }
        }
    }

    const damagePenalty = (player.ship.devices.phaser || 0) / 100;
    const cooldown = PHASER_COOLDOWN + Math.random() * PHASER_COOLDOWN + damagePenalty;
    player.ship.cooldowns.phasersAvailableAt[bankIndex] = now + cooldown;

    if (Math.random() * 100 < (energy - 50) * (60 / 450) + 5) {
        const overheatDamage = 300 + Math.random() * 600;
        player.ship.devices.phaser += overheatDamage;
        const dmg = Math.round(overheatDamage);
        switch (player.settings.output) {
            case "SHORT": sendMessageToClient(player, `PH > OH ${dmg}`); break;
            case "MEDIUM": sendMessageToClient(player, `Phaser bank overheated (${dmg} dmg)`); break;
            case "LONG": sendMessageToClient(player, `Phaser bank overheated! ${dmg} damage sustained to internal systems.`); break;
        }
    }

    if (player.ship.romulanStatus.isRomulan) {
        player.ship.romulanStatus.isRevealed = true;
        setTimeout(() => {
            if (player.ship) player.ship.romulanStatus.isRevealed = false;
        }, 5000);
    }
}

export function applyPhaserShipDamage(source: Player | Planet, target: Player, damage: number, powfac: number, phit: number): void {
    if (source instanceof Player && !source.ship) return;
    if (!target.ship) return;

    console.log("applyPhaserShipDamage", damage, powfac, phit);

    const sourceType = source instanceof Player ? "Player" : "Planet";
    const sourceSide = source instanceof Player ? source.ship!.side : source.side;  //TODO: check if this is correct
    const sourcePos = source instanceof Player ? source.ship!.position : source.position;
    const targetSide = target.ship.side;
    const targetName = target.ship.name;
    const targetPos = target.ship.position;

    if (damage <= 0) {
        if (source instanceof Player) {
            const msg = `${sourceType} (${sourceSide}) at ${sourcePos} fires phasers at ${targetSide} ship ${targetName} at ${targetPos} but misses`;
            sendMessageToClient(source, msg);
        }
        return;
    }

    let hita = damage;
    let effectiveDamage = damage;
    if (target.ship.shieldsUp) {
        const shieldEnergy = target.ship.shieldEnergy || 1000; // Fortran: KSSHPC (0–1000)
        hita = damage;
        effectiveDamage = (1000 - shieldEnergy) * hita * 0.001;
        target.ship.shieldEnergy = Math.max(0, shieldEnergy - (hita * powfac * phit * Math.max(shieldEnergy * 0.001, 0.1) + 10) * 0.03);
        if (target.ship.shieldEnergy <= 0) target.ship.shieldsUp = false;
    } else {
        effectiveDamage = hita * powfac * phit;
    }

    console.log("effectiveDamage", effectiveDamage);

    // Apply damage (Fortran: block 500)
    target.ship.energy = Math.max(0, target.ship.energy - effectiveDamage);
    target.ship.damage += effectiveDamage;

    // Critical hit (Fortran: block 400)
    if (effectiveDamage * (Math.random() + 0.1) >= 1700) {
        const deviceKeys = Object.keys(target.ship.devices) as (keyof typeof target.ship.devices)[];
        const randomDevice = deviceKeys[Math.floor(Math.random() * deviceKeys.length)];
        target.ship.devices[randomDevice] = Math.min(target.ship.devices[randomDevice] + effectiveDamage / 2, 1000);
        if (randomDevice === "shield") target.ship.shieldsUp = false;
        addPendingMessage(target, `CRITICAL HIT: ${randomDevice} damaged (${Math.round(effectiveDamage / 2)})!`);
    }

    // Update condition (Fortran: KSPCON = RED)
    if (target.ship.shieldEnergy <= 0 || target.ship.energy <= 200) {
        target.ship.condition = 'RED';
    } else if (target.ship.shieldEnergy <= 250 || target.ship.energy <= 500) {
        target.ship.condition = 'YELLOW';
    } else {
        target.ship.condition = 'GREEN';
    }

    const sourceName = source instanceof Player && source.ship ? source.ship.name : source instanceof Planet ? "Starbase" : "Unknown";
    const targetShieldPct = target.ship.computeShieldPercent();

    if (source instanceof Player) {
        const attackerMessage = formatPhaserHit({
            attacker: sourceName,
            target: target.ship.name ?? "Unknown",
            damage: effectiveDamage,
            attackerPos: sourcePos,
            targetShieldPercent: targetShieldPct,
            outputLevel: source.settings.output
        });
        sendMessageToClient(source, attackerMessage);

        if (source.ship) {
            if (target.ship.romulanStatus?.isRomulan) {
                pointsManager.addDamageToRomulans(effectiveDamage, source, source.ship.side);
            } else {
                pointsManager.addDamageToEnemies(effectiveDamage, source, source.ship.side);
            }
        }

        const targetMessage = formatPhaserHit({
            attacker: sourceName,
            target: target.ship.name ?? "Unknown",
            damage: effectiveDamage,
            attackerPos: sourcePos,
            targetShieldPercent: targetShieldPct,
            outputLevel: target.settings.output
        });
        addPendingMessage(target, targetMessage);

        sendFormattedMessageToObservers({
            origin: target.ship.position,
            attacker: sourceName,
            target: target.ship.name ?? "Unknown",
            damage: effectiveDamage,
            targetShieldPercent: targetShieldPct,
            formatFunc: formatPhaserHit
        });

        if (target.ship.energy <= 0 || target.ship.damage >= DESTRUCTION_DAMAGE_THRESHOLD) {
            sendMessageToClient(target, `Your ship was destroyed by ${sourceName} with phasers.`);
            removePlayerFromGame(target);
            if (source instanceof Player) {
                sendMessageToClient(source, `${sourceName} destroyed ${targetSide} ship ${targetName} at ${targetPos} with phasers.`);
                if (source.ship)
                    pointsManager.addEnemiesDestroyed(1, source, source.ship.side); // Fortran: 5000 points
            }
        }
    }
}

export function applyPhaserBaseDamage(player: Player, target: Planet, damage: number, powfac: number, phit: number): void {
    if (!player.ship) return;

    const baseEnergy = target.energy || 1000; // Fortran: base(j,3,nplc-2) (0–1000)
    if (baseEnergy === 1000 && !target.hasCriedForHelp) {
        target.hasCriedForHelp = true;
        target.callForHelp(target.position.v, target.position.h, target.side);
    }

    // Apply damage (Fortran: block 900)
    const hita = damage;
    const effectiveDamage = (1000 - baseEnergy) * hita * 0.001;
    target.energy = Math.max(0, baseEnergy - (hita * powfac * phit * Math.max(baseEnergy * 0.001, 0.1) + 10) * 0.03);
    target.energy = Math.max(0, Math.floor(target.energy - effectiveDamage * 0.01)); // Fortran: hita * 0.01

    // Critical hit (Fortran: block 1400)
    if (Math.random() < 0.2) { // Fortran: iran(5) == 5
        target.energy = Math.max(0, target.energy - (50 + Math.random() * 100));
    }

    pointsManager.addDamageToBases(effectiveDamage, player, player.ship.side);
    sendMessageToClient(player, formatPhaserBaseHit({ player, base: target, damage: effectiveDamage }));

    if (target.energy <= 0) {
        target.isBase = false;
        const baseArray = target.side === "FEDERATION" ? bases.federation : bases.empire;
        const index = baseArray.findIndex(b => b.position.v === target.position.v && b.position.h === target.position.h);
        if (index !== -1) baseArray.splice(index, 1);
        pointsManager.addDamageToBases(10000, player, player.ship.side); // Fortran: 10000 points
        sendMessageToClient(player, formatPhaserBaseDestroyed({ player, base: target }));
        checkEndGame();
    }
}

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

                applyPhaserShipDamage(base, player, baseHit, powfac, phit); // Fixed TS2554
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