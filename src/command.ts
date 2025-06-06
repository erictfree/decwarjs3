import { Player } from './player.js';
// import { promoteCommand } from './admin.js';
// import { usersCommand } from './users.js';
// import { sendMessageToClient } from './communication.js';
// import { moveCommand } from './move.js';
// import { helpCommand } from './help.js';
import { shieldCommand } from './shield.js';
// import { radioCommand } from './radio.js';
// import { planetsCommand } from './planets.js';
// import { captureCommand } from './capture.js';
// import { buildCommand } from './build.js';
// import { dockCommand } from './dock.js';
import { shortRangeScanCommand } from './srs.js';
// import { statusCommand } from './status.js';
// import { pointsCommand } from './points.js';
// import { summaryCommand } from './summary.js';
// import { listCommand } from './list.js';
// import { basesCommand } from './bases.js';
// import { targetsCommand } from './targets.js';
// import { tellCommand } from './tell.js';
// import { setCommand } from './set.js';
// import { phaserCommand } from './phaser.js';
// import { newsCommand } from './news.js';
// import { torpedoCommand } from './torpedo.js';
// import { repairCommand } from './repair.js';
import { scanCommand } from './scan.js';
import { timeCommand } from './time.js';
// import { tractorCommand } from './tractor.js';
// import { impulseCommand } from './move.js';
// import { xgridCommand } from './grid.js';
// import { energyCommand } from './energy.js';
// import { damagesCommand } from './damage.js';
// import { typeCommand } from './type.js';
// import { gripeCommand } from './gripe.js';
// import { quitCommand } from './quit.js';
// import { restartCommand } from './restart.js';
// import { clearCommand } from './util/clear.js';
import { sendMessageToClient } from './communication.js';


interface TokenizedInput {
    tokens: string[][];
}

// --- Command Class ---

// eslint-disable-next-line no-unused-vars
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
    // ["BA", basesCommand],
    // ["BU", buildCommand],
    // ["CA", captureCommand],
    // ["CL", clearCommand],
    // ["DA", damagesCommand],
    // ["DO", dockCommand],
    // //["UD", defaultHandler],
    // ["EN", energyCommand],
    // ["GR", gripeCommand],
    // ["H", helpCommand],
    // ["?", helpCommand],
    // ["IM", impulseCommand],
    // ["LI", listCommand],
    // ["M", moveCommand],
    // ["NE", newsCommand],
    // ["PH", phaserCommand],
    // ["PL", planetsCommand],
    // ["PO", pointsCommand],
    // ["PR", promoteCommand],
    // ["Q", quitCommand],
    // ["RA", radioCommand],
    // ["RE", repairCommand],
    // ["RS", restartCommand],
    ["SC", scanCommand],
    // ["SE", setCommand],
    ["SH", shieldCommand],
    ["SR", shortRangeScanCommand],
    // ["ST", statusCommand],
    // ["SU", summaryCommand],
    // ["TA", targetsCommand],
    // ["TE", tellCommand],
    ["TI", timeCommand],
    // ["TO", torpedoCommand],
    // ["TR", tractorCommand],
    // ["TY", typeCommand],
    // ["U", usersCommand],
    // ["XGRID", xgridCommand]
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
        ([key]) => commandKey.startsWith(key)
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
        //sendAllPendingMessages()
        processNextCommand(player);
    } else {
        matchedCommand(player, commandObject, () => {
            //gameSettings.timeConsumingMoves++;  PUT BACK TODO
            player.processingCommand = false;
            processNextCommand(player);
        });
    }
}