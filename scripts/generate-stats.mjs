#!/usr/bin/env node
// Renders assets/stats-{light,dark}.svg and assets/top-langs-{light,dark}.svg
// from the GitHub API and commits them, so the README serves static files from
// this repo instead of a shared card service that runs out of API quota.
//
//   GH_TOKEN=$(gh auth token) node scripts/generate-stats.mjs

import { writeFile } from 'node:fs/promises';

const USER = process.env.STATS_USER || 'bohdanbulakh';
const TOKEN = process.env.GH_TOKEN || '';
const OUT = new URL('../assets/', import.meta.url);

const W = 420;
const H = 200;
const PAD = 24;

// Categorical slots 1-6 + a deliberately neutral "Other" bucket. Stack order is
// slot order, which is the adjacency the palette is validated on: worst adjacent
// CVD dE 9.1 light / 8.4 dark. Do not reorder without re-running the validator.
const THEMES = {
  light: {
    surface: '#ffffff',
    primary: '#0b0b0b',
    secondary: '#52514e',
    muted: '#898781',
    hairline: '#e1e0d9',
    track: '#f0efec',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
    other: '#898781',
  },
  dark: {
    surface: '#0d1117',
    primary: '#ffffff',
    secondary: '#c3c2b7',
    muted: '#898781',
    hairline: '#21262d',
    track: '#21262d',
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'],
    other: '#898781',
  },
};

const FONT = "system-ui, -apple-system, 'Segoe UI', Ubuntu, sans-serif";

// ---------------------------------------------------------------- api

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'profile-stats-generator',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function graphql(query) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'profile-stats-generator',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    throw new Error(`graphql -> ${res.status} ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

async function allRepos() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/users/${USER}/repos?per_page=100&type=owner&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.filter((r) => !r.fork && !r.archived);
}

async function languageBytes(repos) {
  const totals = new Map();
  // Small serial batches: the whole run is ~50 requests, well inside the
  // 5000/h a workflow token gets.
  for (let i = 0; i < repos.length; i += 8) {
    const slice = repos.slice(i, i + 8);
    const results = await Promise.all(
      slice.map((r) => api(`/repos/${r.full_name}/languages`).catch(() => ({}))),
    );
    for (const langs of results) {
      for (const [name, bytes] of Object.entries(langs)) {
        totals.set(name, (totals.get(name) || 0) + bytes);
      }
    }
  }
  return totals;
}

async function contributions() {
  try {
    const data = await graphql(`{
      user(login: "${USER}") {
        contributionsCollection {
          totalCommitContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          totalRepositoriesWithContributedCommits
          contributionCalendar { totalContributions }
        }
      }
    }`);
    const c = data.user.contributionsCollection;
    return {
      commits: c.totalCommitContributions,
      prs: c.totalPullRequestContributions,
      reviews: c.totalPullRequestReviewContributions,
      activeRepos: c.totalRepositoriesWithContributedCommits,
      total: c.contributionCalendar.totalContributions,
    };
  } catch (err) {
    // A repo-scoped GITHUB_TOKEN can be refused here; the card just drops
    // those tiles rather than failing the whole run.
    console.warn(`contributions unavailable: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function compact(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

// Conservative advance-width estimate; used only to decide whether a direct
// label fits inside a segment, so over-estimating is the safe direction.
const textWidth = (text, size, weight = 400) =>
  text.length * size * (weight >= 600 ? 0.60 : 0.55);

function roundedPath(x, y, w, h, rl, rr) {
  const l = Math.min(rl, w / 2);
  const r = Math.min(rr, w / 2);
  return [
    `M${(x + l).toFixed(2)},${y}`,
    `H${(x + w - r).toFixed(2)}`,
    r ? `a${r},${r} 0 0 1 ${r},${r}` : '',
    `V${y + h - r}`,
    r ? `a${r},${r} 0 0 1 ${-r},${r}` : '',
    `H${(x + l).toFixed(2)}`,
    l ? `a${l},${l} 0 0 1 ${-l},${-l}` : '',
    `V${y + l}`,
    l ? `a${l},${l} 0 0 1 ${l},${-l}` : '',
    'Z',
  ].filter(Boolean).join(' ');
}

// WCAG relative luminance, for picking ink vs white on top of a fill.
function inkOn(hex) {
  const v = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  return lum > 0.45 ? '#0b0b0b' : '#ffffff';
}

const frame = (body, title, desc) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" `
  + `role="img" aria-labelledby="t d">\n`
  + `<title id="t">${esc(title)}</title>\n<desc id="d">${esc(desc)}</desc>\n`
  + `<style>text{font-family:${FONT};}</style>\n${body}\n</svg>\n`;

// ---------------------------------------------------------------- stats card

function statsCard(theme, data) {
  const t = THEMES[theme];
  const { user, stars, c, langCount } = data;

  const candidates = [
    { label: 'Public repos', value: user.public_repos, on: true },
    { label: 'Stars earned', value: stars, on: stars > 0 },
    { label: 'Commits (12 mo)', value: c?.commits, on: !!c },
    { label: 'Contributions', value: c?.total, on: !!c },
    { label: 'Pull requests', value: c?.prs, on: !!c && c.prs > 0 },
    { label: 'Active repos', value: c?.activeRepos, on: !!c },
    { label: 'Languages', value: langCount, on: true },
    { label: 'Followers', value: user.followers, on: true },
  ];
  const tiles = candidates.filter((x) => x.on).slice(0, 6);

  const cols = 3;
  const colW = (W - PAD * 2) / cols;
  const rowY = [104, 158];

  const parts = [
    `<rect width="${W}" height="${H}" rx="6" fill="${t.surface}"/>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="none" `
      + `stroke="${t.hairline}"/>`,
    `<text x="${PAD}" y="36" font-size="17" font-weight="600" fill="${t.primary}">`
      + `${esc(user.name || user.login)}</text>`,
    `<text x="${PAD}" y="55" font-size="11.5" fill="${t.muted}">`
      + `@${esc(user.login)} &#183; last 12 months</text>`,
    `<line x1="${PAD}" y1="70" x2="${W - PAD}" y2="70" stroke="${t.hairline}"/>`,
  ];

  tiles.forEach((tile, i) => {
    const x = PAD + (i % cols) * colW;
    const y = rowY[Math.floor(i / cols)];
    parts.push(
      `<text x="${x}" y="${y}" font-size="25" font-weight="600" fill="${t.primary}">`
        + `${compact(tile.value)}</text>`,
      `<text x="${x}" y="${y + 17}" font-size="10.5" fill="${t.muted}">`
        + `${esc(tile.label)}</text>`,
    );
  });

  const desc = tiles.map((x) => `${x.label}: ${x.value.toLocaleString('en-US')}`).join('. ');
  return frame(parts.join('\n'), `GitHub statistics for ${user.login}`, desc);
}

// ---------------------------------------------------------------- language card

function langCard(theme, data) {
  const t = THEMES[theme];
  const { langs, total, repoCount } = data;

  const barX = PAD;
  const barY = 74;
  const barW = W - PAD * 2;
  const barH = 18;
  const GAP = 2;
  const RADIUS = 4;

  const colorOf = (i) => (langs[i].name === 'Other' ? t.other : t.series[i]);

  // Lay out on the gap-free width, then take the gap out of each segment's
  // right edge so the surface itself does the separating.
  const inner = barW - GAP * (langs.length - 1);
  const widths = langs.map((l) => Math.max((l.bytes / total) * inner, 3));
  const scale = inner / widths.reduce((a, b) => a + b, 0);

  const parts = [
    `<rect width="${W}" height="${H}" rx="6" fill="${t.surface}"/>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="none" `
      + `stroke="${t.hairline}"/>`,
    `<text x="${PAD}" y="36" font-size="17" font-weight="600" fill="${t.primary}">`
      + `Top languages</text>`,
    `<text x="${PAD}" y="55" font-size="11.5" fill="${t.muted}">`
      + `by bytes of code across ${repoCount} public repos</text>`,
  ];

  let cursor = barX;
  const geometry = langs.map((lang, i) => {
    const w = widths[i] * scale;
    const seg = { x: cursor, w, color: colorOf(i), lang };
    cursor += w + GAP;
    return seg;
  });

  for (const [i, seg] of geometry.entries()) {
    parts.push(
      `<path d="${roundedPath(seg.x, barY, seg.w, barH, i === 0 ? RADIUS : 0,
        i === geometry.length - 1 ? RADIUS : 0)}" fill="${seg.color}"/>`,
    );
  }

  // Only the segments with genuine room get an inline label; the legend
  // carries the rest rather than clipping text inside a 20px sliver.
  for (const seg of geometry) {
    const label = `${seg.lang.name} ${seg.lang.pct}%`;
    if (textWidth(label, 10.5, 600) + 16 > seg.w) continue;
    parts.push(
      `<text x="${(seg.x + seg.w / 2).toFixed(2)}" y="${barY + barH / 2 + 3.8}" `
        + `text-anchor="middle" font-size="10.5" font-weight="600" `
        + `fill="${inkOn(seg.color)}">${esc(label)}</text>`,
    );
  }

  // Legend: two columns, always present, so identity never rests on color.
  const legendY = 118;
  const rowH = 20;
  const colX = [PAD, PAD + 190];
  langs.forEach((lang, i) => {
    const x = colX[Math.floor(i / 4)];
    const y = legendY + (i % 4) * rowH;
    parts.push(
      `<rect x="${x}" y="${y - 8}" width="10" height="10" rx="2" fill="${colorOf(i)}"/>`,
      `<text x="${x + 17}" y="${y}" font-size="11.5" fill="${t.secondary}">`
        + `${esc(lang.name)}</text>`,
      `<text x="${x + 160}" y="${y}" font-size="11.5" text-anchor="end" `
        + `fill="${t.muted}" font-variant-numeric="tabular-nums">${lang.pct}%</text>`,
    );
  });

  const desc = langs.map((l) => `${l.name} ${l.pct}%`).join(', ');
  return frame(parts.join('\n'), `Top languages used by ${USER}`, desc);
}

// ---------------------------------------------------------------- main

async function main() {
  const [user, repos] = await Promise.all([api(`/users/${USER}`), allRepos()]);
  const [bytes, c] = await Promise.all([languageBytes(repos), contributions()]);

  const stars = repos.reduce((sum, r) => sum + r.stargazers_count, 0);
  const total = [...bytes.values()].reduce((a, b) => a + b, 0);
  if (!total) throw new Error('no language bytes returned');

  const ranked = [...bytes.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 6);
  const rest = ranked.slice(6).reduce((sum, [, v]) => sum + v, 0);
  // One decimal everywhere, so the legend column reads as a set (9.0%, not 9%).
  const pct = (b) => ((b / total) * 100).toFixed(1);
  const langs = top.map(([name, b]) => ({ name, bytes: b, pct: pct(b) }));
  if (rest > 0) langs.push({ name: 'Other', bytes: rest, pct: pct(rest) });

  const data = { user, stars, c, langs, total, repoCount: repos.length, langCount: bytes.size };

  for (const theme of ['light', 'dark']) {
    await writeFile(new URL(`stats-${theme}.svg`, OUT), statsCard(theme, data));
    await writeFile(new URL(`top-langs-${theme}.svg`, OUT), langCard(theme, data));
  }

  console.log(`${repos.length} repos, ${bytes.size} languages, ${stars} stars`);
  console.log(langs.map((l) => `${l.name} ${l.pct}%`).join(', '));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
