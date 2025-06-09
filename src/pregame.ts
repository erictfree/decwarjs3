// pregame command dispatcher for DECWAR-style game
import { Player } from './player.js';
import { Command, CommandHandler, tokenize } from './command.js';
import { sendMessageToClient } from './communication.js';
import { generateGalaxy } from './game.js';

// Import only the valid pre-game handlers
import { activateCommand } from './activate.js';
import { gripeCommand } from './gripe.js';
import { helpCommand } from './help.js';
import { newsCommand } from './news.js';
//import { pointsCommand } from './points.js';
import { timeCommand } from './time.js';
import { usersCommand } from './users.js';
import { quitCommand } from './quit.js';
import { findEmptyLocation } from './coords.js';
import {
    FEDERATION_SHIPS,
    EMPIRE_SHIPS,
    Side,
    settings
} from './settings.js';
import { Ship } from './ship.js';
import { generateAccessCode, isValidEmail } from './util/auth.js';
import { sendEmail } from './util/send-email.js';
import { addEmailToMailchimp } from './util/email.js';
import { setRandomSeed } from './util/random.js';
import { players } from './game.js';
import { setegid } from 'process';

// Map of pre-game command keys to their handlers
const pgCommands = new Map<string, CommandHandler>([
    ['AC', activateCommand],    // ACTIVATE
    ['GR', gripeCommand],       // GRIPE
    ['HE', helpCommand],        // HELP
    ['NE', newsCommand],        // NEWS
    ['TI', timeCommand],        // TIME
    ['US', usersCommand],       // USERS
    ['QU', quitCommand],       // QUIT
]);

/**
 * Parses and executes pre-game (lobby) commands.
 * Routes input to the pgCommands map.
 */
export function parseAndExecutePGCommand(player: Player, input: string): void {
    if (!player) {
        sendMessageToClient(player, `Unknown player (pgCommand)`);
        return;
    }

    try {
        const parsed = tokenize(input);

        if (Array.isArray(parsed.tokens) && parsed.tokens.length > 0) {
            for (const commandTokens of parsed.tokens) {
                const commandKey = commandTokens[0].toUpperCase();
                const commandObject = new Command(
                    commandKey,
                    commandTokens.slice(1),
                    input
                );

                // Find the first handler whose key matches the start of the input
                let matchedHandler: CommandHandler | null = null;
                for (const [key, handler] of pgCommands) {
                    if (key[0] == commandKey.toUpperCase()[0]) {  // note matches 1 letter, make sure this stays legit
                        matchedHandler = handler;
                        break;
                    }
                }

                if (matchedHandler) {
                    matchedHandler(player, commandObject);
                    sendMessageToClient(player, "", false, true);
                } else {
                    sendMessageToClient(
                        player,
                        `Unknown pre-game command: ${commandKey}`
                    );
                }
            }
        }
    } catch (error: unknown) {
        sendMessageToClient(
            player,
            `Error parsing pre-game command: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export function promptForEmail(player: Player, iter: number): void {
    if (iter > 4) {
        sendMessageToClient(player, "Too many attempts. Please try again later.");
        return;
    }
    player.currentPrompt = `ENTER EMAIL FOR ACCESS: `;
    player.callBack = (pl, resp) => {
        const trimmed = resp.trim();
        if (trimmed === "theq") {
            pl.auth.authed = true;
            if (settings.generated) {
                sendMessageToClient(player, `There are ${settings.romulans ? "" : "no "}Romulans in this game.`);
                sendMessageToClient(player, `There are ${settings.blackholes ? "" : "no "}Black holes in this game.`);
                sendMessageToClient(player,
                    `Currently there are ${players.filter(p => p.ship?.side === "FEDERATION").length} Federation ships and ${players.filter(p => p.ship?.side === "EMPIRE").length} Empire ships.\r\n`);
                promptForLevel(pl, 0);
            } else {
                promptForRegularOrTournament(pl, 0);
            }
            // sendMessageToClient(pl, "Welcome back to the game Captain!");
            // if (pl.ship.side != "NEUTRAL") {
            //     promptForShip(pl, 0);
            // } else {
            //     promptForSide(pl, 0);
            // }
        } else if (isValidEmail(trimmed)) {
            //const prevPlayer = emailHasSameIp(trimmed, pl.auth.ip);
            // if (prevPlayer) {
            //     if (prevPlayer.ship.side) {
            //         pl.ship.side = prevPlayer.ship.side;
            //     }
            //     pl.settings = { ...prevPlayer.settings };
            //     pl.auth.authed = true;
            //     sendMessageToClient(pl, "Welcome back to the game Captain!");
            //     promptForShip(pl, 0);
            //     return;
            // } else {

            pl.auth.email = trimmed;
            pl.auth.code = generateAccessCode();
            pl.auth.createdAt = Date.now();

            sendEmail({
                to: trimmed,
                subject: 'DECWARJS Access Code',
                text: `Welcome to DECWARJS!\n\nYour one-time login code is: ${pl.auth.code}`
            }).catch(err => {
                console.error(`Failed to send email to ${trimmed}:`, err);
                // Optionally notify the player:
                sendMessageToClient(pl, "Email error. Please try again later.");
                return;
            });
            addEmailToMailchimp(trimmed);
            promptForAccessCode(pl, 0);
            // }
        } else {
            sendMessageToClient(pl, "Invalid email.");
            promptForEmail(pl, iter + 1);
            sendMessageToClient(player, "", false, true);
        }

    };
}

export function promptForAccessCode(player: Player, iter: number): void {
    if (iter > 4) {
        sendMessageToClient(player, "Too many attempts. Please try again later.");
        return;
    }
    player.currentPrompt = "ACCESS CODE: ";
    player.callBack = (pl, resp) => {
        const trimmed = resp.trim();
        if (trimmed === pl.auth.code) {
            pl.auth.authed = true;
            if (settings.generated) {
                promptForLevel(pl, 0);
            } else {
                promptForRegularOrTournament(pl, 0);
            }
        } else {
            sendMessageToClient(pl, "Invalid access code, check email for code.");
            promptForAccessCode(pl, iter + 1);
        }
    };
    sendMessageToClient(player, "", false, true);
}

export function promptForRegularOrTournament(player: Player, iter: number): void {
    if (iter > 4) {
        sendMessageToClient(player, "Too many attempts. Please try again later.");
        return;
    }
    player.currentPrompt = "Regular or Tournament game? ";
    player.callBack = (pl, resp) => {
        const trimmed = resp.trim();
        if (trimmed.toUpperCase().startsWith("R")) {
            setRandomSeed(Date.now().toString());
            generateGalaxy();
            promptForLevel(pl, 0);
        } else if (trimmed.toUpperCase().startsWith("T")) {
            promptForSeed(pl, 0);
        } else {
            sendMessageToClient(pl, "Please enter R or T. ");
            promptForRegularOrTournament(pl, iter + 1);
        }
    };
    sendMessageToClient(player, "", false, true);
}
export function promptForSeed(player: Player, iter: number): void {
    if (iter > 4) {
        sendMessageToClient(player, "Too many attempts. Please try again later.");
        return;
    }
    player.currentPrompt = "Tournament name or number: ";
    player.callBack = (pl, resp) => {
        const trimmed = resp.trim();
        if (trimmed.length >= 1) {
            setRandomSeed(trimmed);
            promptForRomulanEmpire(pl, 0);
        } else {
            sendMessageToClient(pl, "Invalid entry.");
            promptForSeed(pl, iter + 1);
        }
    };
    sendMessageToClient(player, "", false, true);
}

export function promptForLevel(player: Player, iter: number): void {
    if (false) {//} && getPlayerSettings(player)) {  //TODO
        chooseSide(player);
        return;
    }
    if (iter > 4) {
        sendMessageToClient(player, "Too many attempts. Please try again later.");
        return;
    }
    player.currentPrompt = `Are you:\r\n1 Beginner\r\n2 Intermediate\r\n3 Expert\r\n\r\nWhich? `;
    player.callBack = (pl, resp) => {
        const trimmed = resp.trim();
        if (["1", "2", "3"].includes(trimmed)) {
            const level = parseInt(trimmed);

            if (level === 1) {
                // Beginner settings
                pl.settings.prompt = "NORMAL";
                pl.settings.scan = "LONG";
                pl.settings.ocdef = "BOTH";
                pl.settings.icdef = "ABSOLUTE";
                pl.settings.output = "MEDIUM";
            } else if (level === 2) {
                // Intermediate settings
                pl.settings.prompt = "INFORMATIVE";
                pl.settings.scan = "LONG";
                pl.settings.ocdef = "BOTH";
                pl.settings.icdef = "RELATIVE";
                pl.settings.output = "MEDIUM";
            } else if (level === 3) {
                // Expert settings
                pl.settings.prompt = "INFORMATIVE";
                pl.settings.scan = "SHORT";
                pl.settings.ocdef = "BOTH";
                pl.settings.icdef = "ABSOLUTE";
                pl.settings.output = "SHORT";
            }

            sendMessageToClient(pl, "Medium output format.\r\nNormal command prompt.\r\nLong SCAN format.\r\nAbsolute coordinates are default for input.\r\nBoth coordinates are default for output.\r\n");

            chooseSide(pl);
        } else {
            sendMessageToClient(pl, "Invalid choice. Please enter 1, 2, or 3.");
            promptForLevel(pl, iter + 1);
        }
    };
    sendMessageToClient(player, "", false, true);
}

export function chooseSide(player: Player): void {
    if (!player.ship) {
        sendMessageToClient(player, "You must be in a ship to choose a side.");
        return;
    }

    // 1) Compute current balance
    const fedCount = players.filter(p => p.ship!.side === 'FEDERATION').length;
    const empCount = players.filter(p => p.ship!.side === 'EMPIRE').length;

    // 2) Auto‑assign if one side is under‑manned by 2 or more
    if (fedCount + 2 <= empCount) {
        player.ship.side = 'FEDERATION';
        sendMessageToClient(player,
            `Auto-balancing: placing you on Federation (F=${fedCount}, E=${empCount})\r\n`,
            false, true
        );
        return promptForShip(player, 0);
    }
    if (empCount + 2 <= fedCount) {
        player.ship.side = 'EMPIRE';
        sendMessageToClient(player,
            `Auto-balancing: placing you on Empire (F=${fedCount}, E=${empCount})\r\n`,
            false, true
        );
        return promptForShip(player, 0);
    }

    promptForSide(player, 0);
}

function promptForSide(player: Player, iter: number): void {
    if (iter > 4) {
        sendMessageToClient(player, "Too many attempts to choose side. Please try again later.");
        return;
    }
    player.currentPrompt = 'Which side do you wish to join?\r\n(Federation or Empire) ';
    player.callBack = (pl, resp) => {
        if (!pl.ship) {
            sendMessageToClient(pl, "You must be in a ship to choose a side.");
            return;
        }
        const choice = resp.trim().toUpperCase();
        let desired: 'FEDERATION' | 'EMPIRE' | null = null;
        if (choice.startsWith('F')) desired = 'FEDERATION';
        else if (choice.startsWith('E')) desired = 'EMPIRE';
        else if (choice == "") desired = getBalancedSide();  // game chooses side

        if (!desired) {
            return promptForSide(pl, iter + 1);
        }
        pl.ship.side = desired;
        const formattedSide = desired.charAt(0).toUpperCase() + desired.slice(1).toLowerCase();
        sendMessageToClient(pl, `\r\nYou will join the ${formattedSide}.\r\n\r\n`, false, true);
        promptForShip(pl, 0);
    }
    sendMessageToClient(player, "", false, true);
}

export function promptForShip(player: Player, iter: number): void {
    const side = player.ship?.side ?? "NEUTRAL";
    if (side == "NEUTRAL") {
        console.log("Player in promptForShip must choose a side first.");
        return;
    }

    if (iter > 4) {
        sendMessageToClient(player, "Too many attempts to choose ship. Please try again later.");
        return;
    }
    const available = getAvailableShips(side);
    if (available.length === 0) {
        sendMessageToClient(player, `Sorry, no ${side} ships are currently free.`);
        return;
    }

    player.currentPrompt = `These vessels are available:\r\n\r\n${available
        .map(name => name.charAt(0).toUpperCase() + name.slice(1).toLowerCase())
        .join("\r\n")}\r\n\r\nWhich vessel do you desire? `;


    player.callBack = (pl, resp) => {
        let actualShipName;
        const choice = resp ? resp.trim().toUpperCase() : '';

        if (choice == "") {
            actualShipName = getRandomShip(pl.ship!.side);
            if (actualShipName) {
                sendMessageToClient(player, `You will captain the ${actualShipName}`);
            } else {
                sendMessageToClient(player, `Sorry, no ${pl.ship!.side} ships are currently free.`);
                promptForShip(pl, iter + 1);
                return;
            }
        } else {
            const freshAvailable = getAvailableShips(pl.ship!.side); // Recheck in case others claimed
            actualShipName = freshAvailable.find(ship => ship.startsWith(choice));
        }

        if (!actualShipName) {
            // Invalid input or ship no longer available
            if (!choice || !available.some(ship => ship.startsWith(choice))) {
                sendMessageToClient(player, 'That is not a valid ship name.');
            } else {
                sendMessageToClient(player, 'That ship is no longer in inventory.');
            }
            promptForShip(pl, iter + 1); // Recurse to re-prompt
            return;
        }

        const side = pl.ship!.side;
        pl.ship = new Ship(pl);
        // Successful selection
        pl.ship.name = actualShipName;
        pl.ship.side = side;
        pl.ship.position = findEmptyLocation() || { v: 1, h: 1 };

        // Move back to players
        //limbo.splice(limbo.indexOf(player), 1); TODO
        players.push(player);
        sendMessageToClient(player, `\r\nDECWARJS game #${settings.gameNumber}, ${settings.tournamentSeed}\r\n\r\n`, false, true);

        // sendMessageToClient(
        //     player,
        //     `Activated at sector ${pl.ship.position.y}-${pl.ship.position.x}`
        // );
    };

    sendMessageToClient(player, "", false, true); // Trigger the prompt
}

export function getAvailableShips(side: Side): string[] {
    const masterList = side === "FEDERATION" ? FEDERATION_SHIPS : EMPIRE_SHIPS;
    const taken = players.map(p => p.ship?.name ?? "Unknown");
    return masterList.filter(name => !taken.includes(name));
}

function getBalancedSide(): "EMPIRE" | "FEDERATION" {
    const fedCount = players.filter(p => p.ship!.side === "FEDERATION").length;
    const empCount = players.filter(p => p.ship!.side === "EMPIRE").length;

    if (fedCount < empCount) {
        return "FEDERATION";
    } else if (empCount < fedCount) {
        return "EMPIRE";
    } else {
        return Math.random() < 0.5 ? "FEDERATION" : "EMPIRE";
    }
}

function getRandomShip(side: Side): string | null {
    if (side == "NEUTRAL") return null;
    const available = getAvailableShips(side);
    if (available.length === 0) return null;
    const idx = Math.floor(Math.random() * available.length);
    return available[idx];
}


export function promptForRomulanEmpire(player: Player, iter: number): void {
    if (iter > 4) {
        sendMessageToClient(player, "Too many attempts. Please try again later.");
        return;
    }
    player.currentPrompt = "Is the Romulan Empire involved in this conflict? (Yes or No) ";
    player.callBack = (pl, resp) => {
        const trimmed = resp.trim();
        if (trimmed.toUpperCase().startsWith("Y")) {
            settings.romulans = true;
            promptForBlackholes(pl, 0);
        } else if (trimmed.toUpperCase().startsWith("N")) {
            settings.romulans = false;
            promptForBlackholes(pl, 0);
        } else {
            sendMessageToClient(pl, "Please enter Y or N. ");
            promptForRomulanEmpire(pl, iter + 1);
        }
    };
    sendMessageToClient(player, "", false, true);
}


export function promptForBlackholes(player: Player, iter: number): void {
    if (iter > 4) {
        sendMessageToClient(player, "Too many attempts. Please try again later.");
        return;
    }
    player.currentPrompt = "Do you want black holes? (Yes or No) ";

    player.callBack = (pl, resp) => {
        const trimmed = resp.trim();
        if (trimmed.toUpperCase().startsWith("Y")) {
            settings.blackholes = true;

            generateGalaxy();

            promptForLevel(pl, 0);
        } else if (trimmed.toUpperCase().startsWith("N")) {
            settings.blackholes = false;
            generateGalaxy();
            promptForLevel(pl, 0);
        } else {
            sendMessageToClient(pl, "Please enter Y or N. ");
            promptForBlackholes(pl, iter + 1);
        }
    };
    sendMessageToClient(player, "", false, true);
}