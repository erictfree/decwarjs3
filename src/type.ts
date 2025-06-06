import { sendOutputMessage } from './communication.js';
import { Player } from './player.js';
import { settings } from './settings.js';

export function typeCommand(player: Player): void {
    const { version, date, allowRomulans, allowBlackHoles } = settings;
    const { output, prompt, scan, icdef, ocdef } = player.settings;

    const short = `[v1.${version}] ${allowRomulans ? 'Romulans' : 'No Romulans'}, ${output} output, ${icdef} in, ${ocdef} out\r\n`;

    const medium = [
        `[DECWARJS Version 1.${version}, ${date}]`,
        `Romulans: ${allowRomulans ? 'enabled' : 'disabled'}.`,
        `Black holes: ${allowBlackHoles ? 'enabled' : 'disabled'}.`,
        `Output: ${output}`,
        `Prompt: ${prompt}`,
        `SCAN format: ${scan}`,
        `Input coords: ${icdef}`,
        `Output coords: ${ocdef}`
    ].join('\r\n') + '\r\n';

    const longLines: string[] = [
        `[DECWARJS Version 1.${version}, ${date}]`,
        `There ${allowRomulans ? 'are' : 'are no'} Romulans in this game.`,
        `There ${allowBlackHoles ? 'are' : 'are no'} Black holes in this game.\r\n`,
        `Current output switch settings:`,
        `${output === 'LONG' ? 'Long' : output === 'MEDIUM' ? 'Medium' : 'Short'} output format.`,
        `${prompt === 'INFORMATIVE' ? 'Informative' : 'Normal'} command prompt.`,
        `${scan === 'LONG' ? 'Long' : 'Short'} SCAN format.`,
        `${icdef === 'RELATIVE' ? 'Relative' : 'Absolute'} coordinates are default for input.`,
        ocdef === 'RELATIVE'
            ? 'Relative coordinates are default for output.'
            : ocdef === 'ABSOLUTE'
                ? 'Absolute coordinates are default for output.'
                : 'Both relative and absolute coordinates are shown for output.'
    ];

    const long = longLines.join('\r\n') + '\r\n';

    sendOutputMessage(player, {
        SHORT: short,
        MEDIUM: medium,
        LONG: long
    });
}
