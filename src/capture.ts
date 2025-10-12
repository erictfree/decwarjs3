import { Command } from "./command.js";
import { CAPTURE_DELAY_MIN_MS } from "./settings.js";
import {
    sendMessageToClient,
    putClientOnHold,
    releaseClient,
    sendOutputMessage,
    sendMessageToOthers,
} from "./communication.js";
import { getCoordsFromCommandArgs, ocdefCoords, chebyshev } from "./coords.js";
import { Player } from "./player.js";
import { planets, pointsManager, players, blackholes, stars, checkEndGame } from "./game.js";
import { applyDamage } from "./torpedo.js"; // adjust path if your applyDamage lives elsewhere
import { gameEvents, planetRef, attackerRef } from "./api/events.js";


//  import { starbasePhaserDefense } from "./phaser.js"; //TODO: verify this isn't a real part of classic game

export function captureCommand(player: Player, command: Command, done?: () => void): void {
    if (command.args.length < 2) {
        sendMessageToClient(
            player,
            "Usage: CAPTURE [A|R] <vpos> <hpos> — must specify coordinates of target planet. Example: CAPTURE 10 25\r\n"
        );
        done?.();
        return;
    }

    if (player.ship === null) {
        sendMessageToClient(player, "You must be in a ship to use the capture command.\r\n");
        done?.();
        return;
    }

    const { position: { v: targetV, h: targetH }, mode, error } = getCoordsFromCommandArgs(
        player,
        command.args,
        player.ship.position.v,
        player.ship.position.h,
        false
    );

    if (error) {
        sendMessageToClient(player, `${error} for mode ${mode}\r\n`);
        done?.();
        return;
    }

    const planet = planets.find(p => p.position.h === targetH && p.position.v === targetV);
    if (!planet) {
        const shipAtTarget = players.some(p => p.ship && p.ship.position.h === targetH && p.ship.position.v === targetV);
        const blackHoleAtTarget = blackholes.some(bh => bh.position.h === targetH && bh.position.v === targetV);
        const starAtTarget = stars.some(star => star.position.h === targetH && star.position.v === targetV);

        if (shipAtTarget || blackHoleAtTarget || starAtTarget) {
            sendMessageToClient(player, "Capture THAT??  You have GOT to be kidding!!!\r\n");
            done?.();
            return;
        } else {
            sendMessageToClient(player, `No planet at those coordinates, Captain.\r\n`);
            done?.();
            return;
        }
    }

    if (planet.isBase && planet.side !== player.ship.side) {
        sendMessageToClient(player, `Captain, the enemy refuses our surrender ultimatum!\r\n`);
        done?.();
        return;
    }

    if (chebyshev(player.ship.position, { v: targetV, h: targetH }) > 1) {
        sendMessageToClient(player, `${player.ship.name} not adjacent to planet.\r\n`);
        done?.();
        return;
    }

    if (planet.side === player.ship.side) {
        const val = Math.random();
        if (val < 0.33) {
            sendMessageToClient(player, `Planet already captured, sir.\r\n`);
        } else if (val < 0.66) {
            sendMessageToClient(player, `But Captain, he's already on our side!\r\n`);
        } else {
            sendMessageToClient(player, `Captain, are you feeling well?\r\nWe are orbiting a FEDERATION planet!\r\n`);
        }
        done?.();
        return;
    }

    if (planet.captureLock.status) {
        sendMessageToClient(player, `The planet's government refuses to surrender.\r\n`);
        done?.();
        return;
    }

    // removed via Harris reported bug
    // if (player.ship.shieldsUp && player.ship.shieldEnergy > 0) {
    //     sendMessageToClient(player, "CAPTURE denied: shields must be lowered.");
    //     done?.();
    //     return;
    // }

    const hit = 50 + (planet.builds * 30);
    const captureDelayMs = planet.builds * 1000 + CAPTURE_DELAY_MIN_MS;

    if (planet.side !== "NEUTRAL" && planet.side !== player.ship.side) {
        const energyCost = planet.builds * 50;

        if (player.ship.energy < energyCost) {
            sendMessageToClient(player, `Insufficient energy: ${energyCost} required to CAPTURE this planet.\r\n`);
            done?.();
            return;
        }

        player.ship.energy -= energyCost;
    }

    const coords = ocdefCoords(player.settings.ocdef,
        player.ship!.position,
        { v: targetV, h: targetH });

    planet.captureLock = {
        status: true,
        time: Date.now(),
    };

    putClientOnHold(player, `${player.ship.name} capturing ${planet.side} planet ${coords}...`);

    const timer = setTimeout(() => {
        // Always unlock + release + done, no matter what path we take
        try {
            // If the player left their ship during the delay, we’re done
            if (!player.ship) return;

            // Snapshot old state BEFORE mutating
            const oldSide = planet.side;
            const wasBase = !!planet.isBase;
            const oldBuilds = planet.builds;

            // Flip ownership + reset fortifications
            planet.side = player.ship.side;
            planet.isBase = false;
            planet.builds = 0;

            // Human-readable coords (fall back if you already computed `coords` earlier)
            const coords =
                typeof ocdefCoords === "function"
                    ? ocdefCoords(player.settings.ocdef, player.ship.position, planet.position)
                    : `(${planet.position.v},${planet.position.h})`;

            // Broadcast messages
            const othersMsg =
                oldSide === "NEUTRAL"
                    ? `${player.ship.name} has captured a neutral planet at ${coords}.`
                    : `${player.ship.name} has captured a planet at ${coords} from the ${oldSide}.`;

            pointsManager.addPlanetsCaptured(1, player, player.ship.side);
            sendMessageToOthers(player, othersMsg);
            sendOutputMessage(player, {
                SHORT: `captured.`,
                MEDIUM: `captured.`,
                LONG: `captured.`,
            });

            // ---- Emit normalized events ----
            // 1) Ownership change
            gameEvents.emit({
                type: "planet_captured",
                payload: {
                    planet: planetRef(planet),
                    prevSide: oldSide,
                    nextSide: planet.side,
                    by: attackerRef(player),
                },
            });

            // 2) If it used to be a base, announce removal
            if (wasBase) {
                gameEvents.emit({
                    type: "planet_base_removed",
                    payload: {
                        planet: planetRef(planet),
                        reason: "demoted",
                        by: attackerRef(player),
                    },
                });
            }

            // 3) If builds were wiped, announce the delta
            if (oldBuilds > 0) {
                gameEvents.emit({
                    type: "planet_builds_changed",
                    payload: {
                        planet: planetRef(planet),
                        delta: -oldBuilds,
                        newBuilds: 0,
                        reason: "capture",
                        by: attackerRef(player),
                    },
                });
            }

            // ---- Backlash damage (unchanged semantics) ----
            const res = applyDamage(planet, player, hit, Math.random());

            if (res.hita > 0) {
                sendMessageToClient(
                    player,
                    `Planetary resistance hit your ship for ${Math.round(res.hita)} damage.`
                );
            }
            if (res.isDestroyed) {
                checkEndGame();
            }
        } finally {
            // single place that resets the lock and releases UI
            planet.captureLock.status = false;
            releaseClient(player);
            done?.();
        }
    }, captureDelayMs);


    player.currentCommandTimer = timer;
}
