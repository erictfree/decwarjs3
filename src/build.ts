import { getCoordsFromCommandArgs, chebyshev, ocdefCoords } from "./coords.js";
import { ran } from "./util/random.js";
import { planets, bases } from "./game.js";
import {
    MAX_BUILDS_PER_PLANET,
    BUILD_DELAY_MIN_MS,
    BUILD_DELAY_RANGE,
    MAX_BASES_PER_TEAM,
} from "./settings.js";
import {
    putClientOnHold,
    releaseClient,
    sendOutputMessage,
    sendMessageToClient,
} from "./communication.js";
import { Player } from "./player.js";
import { Command } from "./command.js";

// NEW: make sure these are exported from your events module per our earlier patch
import { gameEvents, planetRef, attackerRef } from "./api/events.js";

export function buildCommand(player: Player, command: Command, done?: () => void): void {
    // ---- quick argument / state checks ----
    if (command.args.length < 2) {
        sendMessageToClient(
            player,
            "Usage: BUILD [A|R] <vpos> <hpos> — specify vertical and horizontal coordinates."
        );
        done?.();
        return;
    }
    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to build.");
        done?.();
        return;
    }

    const {
        position: { v: targetV, h: targetH },
        mode,
        error,
    } = getCoordsFromCommandArgs(
        player,
        command.args,
        player.ship.position.v,
        player.ship.position.h,
        false
    );

    if (error) {
        sendMessageToClient(player, `${error} for mode ${mode}`);
        done?.();
        return;
    }

    // must be adjacent to the target planet
    if (chebyshev(player.ship.position, { v: targetV, h: targetH }) > 1) {
        sendMessageToClient(
            player,
            "BUILD failed: you must be adjacent (1 grid unit) to the target planet."
        );
        done?.();
        return;
    }

    const planet = planets.find((p) => p.position.h === targetH && p.position.v === targetV);

    if (!planet) {
        const coords = ocdefCoords(
            player.settings.ocdef,
            player.ship.position,
            { v: targetV, h: targetH }
        );
        sendMessageToClient(player, `No known planet at ${coords}. BUILD aborted.`);
        done?.();
        return;
    }

    if (planet.side === "NEUTRAL") {
        sendMessageToClient(player, "Planet not yet captured.");
        done?.();
        return;
    }

    if (!player.ship || planet.side !== player.ship.side) {
        sendMessageToClient(player, `BUILD denied: planet is held by the ${planet.side}.`);
        done?.();
        return;
    }

    if (planet.isBase) {
        sendMessageToClient(player, "This planet is already a starbase.");
        done?.();
        return;
    }

    if (planet.builds >= MAX_BUILDS_PER_PLANET) {
        sendMessageToClient(player, "BUILD limit reached: this planet is fully fortified.");
        done?.();
        return;
    }

    // ---- async build action with jitter ----
    const delayMs = BUILD_DELAY_MIN_MS + ran() * BUILD_DELAY_RANGE;

    putClientOnHold(player, "Building...");
    const timer = setTimeout(() => {
        releaseClient(player);

        // Re-validate state — things may have changed while we waited
        if (!player.ship) {
            sendMessageToClient(player, "You must be in a ship to build.");
            done?.();
            return;
        }

        // Planet could have changed ownership or become a base in the meantime
        if (planet.side !== player.ship.side) {
            sendMessageToClient(player, `BUILD denied: planet is now held by the ${planet.side}.`);
            done?.();
            return;
        }
        if (planet.isBase) {
            sendMessageToClient(player, "This planet is already a starbase.");
            done?.();
            return;
        }
        if (planet.builds >= MAX_BUILDS_PER_PLANET) {
            sendMessageToClient(player, "BUILD limit reached: this planet is fully fortified.");
            done?.();
            return;
        }

        // Apply the build
        planet.builds += 1;

        gameEvents.emit({
            type: "planet_builds_changed",
            payload: {
                planet: planetRef(planet),
                delta: +1,
                newBuilds: planet.builds,
                reason: "build",
                by: attackerRef(player),
            },
        });

        // award points the instant the 5th build lands (kept to your original rule)
        if (planet.builds === 5) {
            player.points.basesBuilt += 1;
        }

        // If we just hit or exceeded the cap, try to promote to a base
        if (planet.builds >= MAX_BUILDS_PER_PLANET) {
            const teamBases = player.ship.side === "FEDERATION" ? bases.federation : bases.empire;

            // enforce the real cap (no +10 fudge)
            if (teamBases.length >= MAX_BASES_PER_TEAM) {
                sendMessageToClient(
                    player,
                    `Maximum number of ${player.ship.side} starbases already active.`
                );
                done?.();
                return;
            }

            // promote atomically; if another thread already promoted, isBase will be true and we just message
            if (!planet.isBase) {
                planet.makeBase(player.ship.side);
            }

            const coords = ocdefCoords(
                player.settings.ocdef,
                player.ship.position,
                { v: targetV, h: targetH }
            );

            sendOutputMessage(player, {
                SHORT: `Base created.`,
                MEDIUM: `Starbase built at ${coords}.`,
                LONG: `Planet at ${coords} has been promoted to a fully operational starbase.`,
            });

            gameEvents.emit({
                type: "planet_base_created",
                payload: {
                    planet: planetRef(planet),
                    by: attackerRef(player),
                },
            });

            done?.();
            return;
        }

        // Otherwise, just report progress
        {
            const coords = ocdefCoords(
                player.settings.ocdef,
                player.ship.position,
                { v: targetV, h: targetH }
            );
            sendOutputMessage(player, {
                SHORT: `+1 build.`,
                MEDIUM: `Now ${planet.builds} build${planet.builds === 1 ? "" : "s"}.`,
                LONG: `One build added. Planet at ${coords} now has ${planet.builds} build${planet.builds === 1 ? "" : "s"}.`,
            });
        }

        done?.();
    }, delayMs);

    player.currentCommandTimer = timer;
    // starbasePhaserDefense(player); // TODO: Add starbase phaser defense
}
