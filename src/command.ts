import { Player } from './player.js';
import { promoteCommand } from './util/admin.js';
import { usersCommand } from './users.js';
import { moveCommand } from './move.js';
import { helpCommand } from './help.js';
import { shieldCommand } from './shield.js';
import { radioCommand } from './radio.js';
import { planetsCommand } from './planets.js';
import { captureCommand } from './capture.js';
import { buildCommand } from './build.js';
import { dockCommand } from './dock.js';
import { shortRangeScanCommand } from './srs.js';
import { statusCommand } from './status.js';
import { pointsCommand } from './points.js';
import { summaryCommand } from './summary.js';
import { listCommand } from './list.js';
import { basesCommand } from './bases.js';
import { targetsCommand } from './targets.js';
import { tellCommand } from './tell.js';
import { setCommand } from './set.js';
import { phaserCommand } from './phaser.js';
import { newsCommand } from './news.js';
import { torpedoCommand } from './torpedo.js';
import { repairCommand } from './repair.js';
import { scanCommand } from './scan.js';
import { timeCommand } from './time.js';
import { tractorCommand } from './tractor.js';
import { impulseCommand } from './move.js';
import { energyCommand } from './energy.js';
import { damagesCommand } from './damage.js';
import { typeCommand } from './type.js';
import { gripeCommand } from './gripe.js';
import { quitCommand } from './quit.js';
import { restartCommand } from './util/restart.js';
import { clearCommand } from './util/clear.js';
import { sendMessageToClient } from './communication.js';
import { oveCommand } from './ove.js';
import { tweakCommand } from './tweak.js';
import { matchesPattern } from './util/util.js';
import { processTimeConsumingMove, nudgeTCMIdle } from './game.js';

interface TokenizedInput {
    tokens: string[][];
}

// --- Command Class ---

export type CommandHandler = (player: Player, command: Command, done?: () => void) => void;

export class Command {
    constructor(
        public key: string,
        public args: string[],
        public raw: string,
    ) {
        this.key = key;
        this.args = args;
        this.raw = raw;
    }
}

// --- Command Registry ---

const decwarCommands = new Map<string, CommandHandler>([
    ["BAses", basesCommand],
    ["BUild", buildCommand],
    ["CApture", captureCommand],
    ["CLear", clearCommand],
    ["DAmages", damagesCommand],
    ["DOck", dockCommand],
    // //["UD", defaultHandler],
    ["Energy", energyCommand],
    ["GRipe", gripeCommand],
    ["Help", helpCommand],
    ["?", helpCommand],
    ["Impulse", impulseCommand],
    ["LIst", listCommand],
    ["Move", moveCommand],
    ["News", newsCommand],
    ["PHasers", phaserCommand],
    ["PLanets", planetsCommand],
    ["POints", pointsCommand],
    ["PRomote", promoteCommand],
    ["Quit", quitCommand],
    ["RAdio", radioCommand],
    ["REpair", repairCommand],
    ["RStart", restartCommand],
    ["SCan", scanCommand],
    ["SEt", setCommand],
    ["SHield", shieldCommand],
    ["SRscan", shortRangeScanCommand],
    ["STatus", statusCommand],
    ["SUmmary", summaryCommand],
    ["TArgets", targetsCommand],
    ["TEll", tellCommand],
    ["TIme", timeCommand],
    ["TOrpedo", torpedoCommand],
    ["TRactor", tractorCommand],
    ["TYpe", typeCommand],
    ["Users", usersCommand],
    ["Over", oveCommand],
    ["TWeak", tweakCommand]
]);

// --- Tokenization ---

export function tokenize(input: string): TokenizedInput {
    const commandPart = input.replace(/;/g, ' ; ');

    const rawCommands = commandPart
        .split("/")
        .map(cmd => cmd.trim())
        .filter(Boolean);

    const commands = rawCommands.map(cmd =>
        cmd
            .split(/[\s,]+/)
            .map(token => token.trim())
            .filter(Boolean)
    );

    return {
        tokens: commands
    };
}

export function queueCommands(player: Player, input: string): void {
    const parsed = tokenize(input);
    if (!parsed.tokens.length) return;

    for (const commandTokens of parsed.tokens) {
        player.commandQueue.push(commandTokens.join(" "));
    }

    processNextCommand(player);
}

export function processNextCommand(player: Player): void {

    if (player.processingCommand || player.commandQueue.length === 0) {
        sendMessageToClient(player, "", false, true);
        return;
    }

    const raw = player.commandQueue.shift();
    if (!raw) return;

    const tokens = raw.split(/\s+/);
    const commandKey = tokens[0].toUpperCase();
    const commandObject = new Command(commandKey, tokens.slice(1), raw);

    const matchedCommand = [...decwarCommands.entries()].find(
        ([key]) => matchesPattern(commandKey, key)
    )?.[1];

    if (!matchedCommand) {
        sendMessageToClient(player, `Unknown command: ${commandKey}`);
        return processNextCommand(player);
    }

    player.processingCommand = true;

    // Check arity to support legacy sync commands
    if (matchedCommand.length < 3) {
        matchedCommand(player, commandObject);
        player.processingCommand = false;
        // Light, debounced nudge so the world advances if players only use sync cmds.
        nudgeTCMIdle(player);
        //sendAllPendingMessages()
        processNextCommand(player);
    } else {
        matchedCommand(player, commandObject, () => {
            //gameSettings.timeConsumingMoves++;  PUT BACK TODO
            player.processingCommand = false;
            processTimeConsumingMove(player); // true "time consumed"
            processNextCommand(player);
        });
    }
}