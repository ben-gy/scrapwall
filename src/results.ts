/**
 * results.ts — the end-of-run summary.
 *
 * Co-op inverts the "everyone's result" rule (principle #9): it leads with the
 * SHARED outcome — how many waves the fort held and what finally breached the
 * Core — and uses the per-player breakdown to show what each defender CONTRIBUTED
 * (walls raised, scrap hauled, husks felled, breaches patched), never to rank
 * them. A co-op summary that quietly turns teammates into a leaderboard rewards
 * hogging; this one rewards the person who kept the guns fed. So the fort's line
 * is the headline, and the per-player rows are unsorted and un-numbered.
 */

import { seatColor } from './fx';
import type { Game, Player } from './game';

export interface MatchTally {
  runs: number;
  /** Most waves the party has held across this match. */
  best: number;
}

export const emptyTally = (): MatchTally => ({ runs: 0, best: 0 });

export interface Row {
  i: number;
  name: string;
  isSelf: boolean;
  left: boolean;
  built: number;
  harvested: number;
  repaired: number;
  kills: number;
}

export interface Summary {
  waves: number;
  reason: string;
  best: number;
  isBest: boolean;
  rows: Row[];
  totalKills: number;
  totalBuilt: number;
}

export function summarize(g: Game, me: number, prevBest: number): Summary {
  const rows: Row[] = g.players.map((p: Player) => ({
    i: p.i,
    name: p.name,
    isSelf: p.i === me,
    left: p.left,
    built: Math.round(p.contrib.built),
    harvested: Math.round(p.contrib.harvested),
    repaired: Math.round(p.contrib.repaired),
    kills: p.contrib.kills,
  }));
  const waves = g.reached;
  return {
    waves,
    reason: g.overReason || 'the horde broke through',
    best: Math.max(prevBest, waves),
    isBest: waves > prevBest,
    rows,
    totalKills: rows.reduce((a, r) => a + r.kills, 0),
    totalBuilt: rows.reduce((a, r) => a + r.built, 0),
  };
}

export function tallyRun(tally: MatchTally, s: Summary): MatchTally {
  return { runs: tally.runs + 1, best: Math.max(tally.best, s.waves) };
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

export function renderSummary(s: Summary, mode: string, tally: MatchTally): string {
  const solo = s.rows.filter((r) => !r.left).length <= 1;
  const held =
    s.waves > 0
      ? `The fort held <b>${plural(s.waves, 'wave')}</b>`
      : `The Core fell on the <b>first wave</b>`;
  const head = `<p class="rs-head">${held}<span class="rs-reason"> — ${esc(s.reason)}</span></p>`;

  const bestLine = s.isBest
    ? `<p class="rs-best">🏆 New best — ${plural(s.waves, 'wave')} held in ${esc(mode)}!</p>`
    : `<p class="rs-note">Best ${esc(mode)}: ${plural(s.best, 'wave')}</p>`;

  const matchLine =
    tally.runs > 0
      ? `<p class="rs-note">Session: ${plural(tally.runs + 1, 'run')} · best ${plural(Math.max(tally.best, s.waves), 'wave')}</p>`
      : '';

  // Every present defender, unsorted — a contribution board, not a ranking.
  const rows = s.rows
    .filter((r) => !r.left)
    .map(
      (r) => `<li class="rs-row${r.isSelf ? ' is-self' : ''}">
        <span class="rs-dot" style="background:${seatColor(r.i)}"></span>
        <span class="rs-name">${esc(r.name)}${r.isSelf ? ' (you)' : ''}</span>
        <span class="rs-contrib">
          <span title="Structures built">${r.built} built</span>
          <span title="Scrap harvested">${r.harvested} scrap</span>
          <span title="Husks felled by your guns">${r.kills} felled</span>
          <span title="Hit points repaired">${r.repaired} patched</span>
        </span>
      </li>`,
    )
    .join('');

  const foot = `<p class="rs-foot">${plural(s.totalKills, 'husk')} felled and ${plural(s.totalBuilt, 'structure')} raised ${solo ? '' : 'together '}before the wall broke.</p>`;

  return `${head}${bestLine}${matchLine}
    <ul class="rs-rows">${rows}</ul>
    ${foot}`;
}

export function shareText(s: Summary, mode: string): string {
  const solo = s.rows.filter((r) => !r.left).length <= 1;
  const who = solo ? 'I' : 'We';
  return `Scrapwall — ${mode}\n${who} held ${plural(s.waves, 'wave')} and felled ${s.totalKills} husks before ${esc(s.reason)}.\nhttps://scrapwall.benrichardson.dev`;
}

function esc(str: string): string {
  return str.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
