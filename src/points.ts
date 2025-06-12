import { Command } from "./command.js";
import { sendMessageToClient } from "./communication.js";
import { matchesPattern } from "./util/util.js";
import { Player } from './player.js';
import { Side, settings } from './settings.js';
import { pointsManager } from './game.js';

// PointsManager is assumed to be in a separate file (game.js), but included here for completeness
export type PointCategory =
  | 'damageToEnemies'
  | 'enemiesDestroyed'
  | 'damageToBases'
  | 'planetsCaptured'
  | 'basesBuilt'
  | 'damageToRomulans'
  | 'starsDestroyed'
  | 'planetsDestroyed';

type Points = Record<PointCategory, number>;

export class PointsManager {
  private sidePoints: Record<Side, Points>;
  private shipsCommissioned: Record<Side, number>;

  constructor() {
    const empty: Points = {
      damageToEnemies: 0,
      enemiesDestroyed: 0,
      damageToBases: 0,
      planetsCaptured: 0,
      basesBuilt: 0,
      damageToRomulans: 0,
      starsDestroyed: 0,
      planetsDestroyed: 0,
    };
    this.sidePoints = {
      FEDERATION: { ...empty },
      EMPIRE: { ...empty },
      ROMULAN: { ...empty },
      NEUTRAL: { ...empty },
    };
    this.shipsCommissioned = {
      FEDERATION: 0,
      EMPIRE: 0,
      ROMULAN: 0,
      NEUTRAL: 0,
    };
  }

  private add(category: PointCategory, amount: number, player: Player | undefined, side: Side): void {
    console.log(amount, player?.ship?.name, side);
    if (player) {
      player.points[category] += amount;
    }
    if (side == "FEDERATION") {
      this.sidePoints.FEDERATION[category] += amount;
      return;
    } else if (side == "EMPIRE") {
      this.sidePoints.EMPIRE[category] += amount;
      return;
    } else if (side == "ROMULAN") {
      this.sidePoints.ROMULAN[category] += amount;
      return;
    }
  }

  addDamageToEnemies(amount: number, player: Player | undefined, side: Side): void {
    this.add('damageToEnemies', amount, player, side);
  }

  addEnemiesDestroyed(amount: number, player: Player | undefined, side: Side): void {
    this.add('enemiesDestroyed', amount, player, side);
  }

  addDamageToBases(amount: number, player: Player | undefined, side: Side): void {
    this.add('damageToBases', amount, player, side);
  }

  addPlanetsCaptured(amount: number, player: Player | undefined, side: Side): void {
    this.add('planetsCaptured', amount, player, side);
  }

  addBasesBuilt(amount: number, player: Player | undefined, side: Side): void {
    this.add('basesBuilt', amount, player, side);
  }

  addDamageToRomulans(amount: number, player: Player | undefined, side: Side): void {
    this.add('damageToRomulans', amount, player, side);
  }

  addStarsDestroyed(amount: number, player: Player | undefined, side: Side): void {
    this.add('starsDestroyed', amount, player, side);
  }

  addPlanetsDestroyed(amount: number, player: Player | undefined, side: Side): void {
    this.add('planetsDestroyed', amount, player, side);
  }

  incrementShipsCommissioned(side: Side): void {
    this.shipsCommissioned[side]++;
  }

  getShipsCommissioned(side: Side): number {
    return this.shipsCommissioned[side];
  }

  getPointsForSide(side: Side): Points {
    return this.sidePoints[side];
  }
}


// Types for points command
interface Score {
  label: string;
  points: Points;
  ships: number;
  side?: Side; // Tracks side for team scores
}

export function pointsCommand(player: Player, command: Command): void {
  if (!player.ship) {
    sendMessageToClient(player, "You must be in a ship to use this command.");
    return;
  }

  const keywords: string[] = [];
  const filters = ["Me", "I", "Federation", "Human", "Empire", "Klingon", "Romulan", "All"];

  for (const arg of command.args) {
    let matched = false;
    for (const pattern of filters) {
      if (matchesPattern(arg, pattern)) {
        keywords.push(pattern.toUpperCase());
        matched = true;
        break;
      }
    }
    if (!matched) {
      sendMessageToClient(player, `Invalid filter: ${arg}`);
      return;
    }
  }

  const scores: Score[] = [];

  // Default to individual score if no keywords
  if (keywords.length === 0 || keywords.includes("ALL") || keywords.includes("ME") || keywords.includes("I")) {
    scores.push({
      label: player.ship.name,
      points: player.points,
      ships: 1,
      side: player.ship.side
    });
  }

  // Federation score
  if (keywords.includes("ALL") || keywords.includes("FEDERATION") || keywords.includes("HUMAN")) {
    scores.push({
      label: "FEDERATION",
      points: pointsManager.getPointsForSide("FEDERATION"),
      ships: pointsManager.getShipsCommissioned("FEDERATION"),
      side: "FEDERATION"
    });
  }

  // Empire score
  if (keywords.includes("ALL") || keywords.includes("EMPIRE") || keywords.includes("KLINGON")) {
    scores.push({
      label: "EMPIRE",
      points: pointsManager.getPointsForSide("EMPIRE"),
      ships: pointsManager.getShipsCommissioned("EMPIRE"),
      side: "EMPIRE"
    });
  }

  // Romulan score
  if (keywords.includes("ALL") || keywords.includes("ROMULAN")) {
    scores.push({
      label: "ROMULAN",
      points: pointsManager.getPointsForSide("ROMULAN"),
      ships: pointsManager.getShipsCommissioned("ROMULAN"),
      side: "ROMULAN"
    });
  }

  const output = formatScores(scores, player);
  sendMessageToClient(player, output);
}

function formatScores(scores: Score[], player: Player): string {
  if (scores.length < 1 || scores.length > 4) {
    return "";
  }

  // Scaling factors per DECWAR help text
  const pointScales: Record<PointCategory, number> = {
    damageToEnemies: 1,
    enemiesDestroyed: 500,
    damageToBases: 1,
    planetsCaptured: 100,
    basesBuilt: 1000,
    damageToRomulans: 1,
    starsDestroyed: -50,
    planetsDestroyed: -100
  };

  // Point-related headers
  const pointHeaders: { label: string; key: keyof Points }[] = [
    { label: "Damage to enemies", key: "damageToEnemies" },
    { label: "Enemies destroyed", key: "enemiesDestroyed" },
    { label: "Damage to bases", key: "damageToBases" },
    { label: "Planets captured", key: "planetsCaptured" },
    { label: "Bases built", key: "basesBuilt" },
    { label: "Damage to Romulans", key: "damageToRomulans" },
    { label: "Stars destroyed", key: "starsDestroyed" },
    { label: "Planets destroyed", key: "planetsDestroyed" }
  ];

  // Filter headers with non-zero values
  const activeHeaders = pointHeaders.filter(header =>
    scores.some(score => score.points[header.key] !== 0)
  );

  // Fixed headers
  const fixedHeaders = ["", "Total points:", "", "Number of ships:", "Pts. / player:", "Pts. / stardate:"];
  const headers = [...activeHeaders.map(h => h.label), ...fixedHeaders];
  const maxLabelLength = Math.max(...scores.map(s => s.label.length), ...headers.map(h => h.length));
  const colWidth = 15;
  const formatNum = (n: number): string => n.toFixed(0).padStart(6); // DECWAR uses integers

  // Build header row
  let result = " ".repeat(maxLabelLength);
  for (const score of scores) {
    result += score.label.padStart(colWidth);
  }
  result += "\r\n";

  // Build data rows
  for (const header of headers) {
    if (header === "") {
      result += "\r\n";
      continue;
    }
    result += header.padEnd(maxLabelLength);
    for (const score of scores) {
      let value: string;
      switch (header) {
        case "Total points:": {
          const total = activeHeaders.reduce((sum, h) => sum + score.points[h.key] * pointScales[h.key], 0);
          value = formatNum(total);
          break;
        }
        case "Number of ships:": {
          value = formatNum(score.ships);
          break;
        }
        case "Pts. / player:": {
          const total = activeHeaders.reduce((sum, h) => sum + score.points[h.key] * pointScales[h.key], 0);
          const ships = score.ships;
          value = formatNum(ships > 0 ? Math.floor(total / ships) : 0); // Integer division
          break;
        }
        case "Pts. / stardate:": {
          const total = activeHeaders.reduce((sum, h) => sum + score.points[h.key] * pointScales[h.key], 0);
          let turns: number;
          if (score.side && score.side === player.ship?.side && score.ships === 1) {
            // Individual player
            turns = player.stardate;
          } else if (score.side) {
            // Team
            const sideKey = score.side.toLowerCase() as keyof typeof settings.teamTurns;
            turns = settings.teamTurns[sideKey] || 0;
          } else {
            turns = 0;
          }
          value = formatNum(turns > 0 ? Math.floor(total / turns) : 0); // Integer division
          break;
        }
        default: {
          const pointHeader = activeHeaders.find(h => h.label === header);
          value = pointHeader ? formatNum(score.points[pointHeader.key] * pointScales[pointHeader.key]) : "0".padStart(6);
          break;
        }
      }
      result += value.padStart(colWidth);
    }
    result += "\r\n";
  }

  return `\r\n${result}\r\n`;
}