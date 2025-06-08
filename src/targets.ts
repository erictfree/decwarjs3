import { listCommand } from "./list.js";
import { Player } from "./player.js";
import { Command } from "./command.js";

export function targetsCommand(player: Player, command: Command): void {
    const newArgs = ["ENEMY", ...command.args];
    const taggedCommand = { ...command, args: newArgs };

    listCommand(player, taggedCommand);
}