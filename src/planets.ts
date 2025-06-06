import { listCommand } from "./list.js";
import { Player } from "./player.js";
import { Command } from "./command.js";


export function planetsCommand(player: Player, command: Command): void {
    const newArgs = ["PLANETS", ...command.args];
    listCommand(player, { ...command, args: newArgs });
}