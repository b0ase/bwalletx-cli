/**
 * bWalletX branding for the terminal: the block-letter banner (yellow, with a gold shimmer sweep on a TTY) and the
 * yellow pairing QR. Plain yellow without animation when output is piped, in CI, or when NO_COLOR is set.
 */
const ART = [
  '██████╗ ██╗    ██╗ █████╗ ██╗     ██╗     ███████╗████████╗██╗  ██╗',
  '██╔══██╗██║    ██║██╔══██╗██║     ██║     ██╔════╝╚══██╔══╝╚██╗██╔╝',
  '██████╔╝██║ █╗ ██║███████║██║     ██║     █████╗     ██║    ╚███╔╝ ',
  '██╔══██╗██║███╗██║██╔══██║██║     ██║     ██╔══╝     ██║    ██╔██╗ ',
  '██████╔╝╚███╔███╔╝██║  ██║███████╗███████╗███████╗   ██║   ██╔╝ ██╗',
  '╚═════╝  ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝',
];

const tty = () => !!process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI;
const truecolor = () => /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
const rgb = (r: number, g: number, b: number) => (truecolor() ? `\x1b[38;2;${r};${g};${b}m` : '\x1b[33m');
const RESET = '\x1b[0m';
const GOLD = [245, 184, 0] as const; // #F5B800
const LIGHT = [255, 236, 150] as const;

export const yellow = (s: string) => (tty() || process.env.FORCE_COLOR ? `${rgb(...GOLD)}${s}${RESET}` : s);

/** One frame: gold, with a bright band centred on column `at`. */
const frame = (at: number) =>
  ART.map((line) =>
    [...line]
      .map((ch, x) => {
        const d = Math.abs(x - at);
        const t = d < 6 ? 1 - d / 6 : 0;
        const c = GOLD.map((g, i) => Math.round(g + (LIGHT[i] - g) * t)) as [number, number, number];
        return `${rgb(...c)}${ch}`;
      })
      .join('') + RESET,
  ).join('\n');

/** Prints the banner; on a terminal a light band sweeps across it once (~0.7 s). */
export async function banner(out: (s: string) => void = (s) => process.stdout.write(s)) {
  if (!tty()) {
    out(ART.join('\n') + '\n');
    return;
  }
  const width = Math.max(...ART.map((l) => l.length));
  out('\x1b[?25l'); // hide cursor
  for (let at = -6; at <= width + 6; at += 3) {
    out(frame(at) + '\n');
    await new Promise((r) => setTimeout(r, 25));
    out(`\x1b[${ART.length}A`); // back to the top of the banner
  }
  out(ART.map((l) => yellow(l)).join('\n') + '\n\x1b[?25h');
}

/** Colour a terminal QR (from qrcode's `small` renderer) yellow on the terminal background, framed with the brand. */
export const brandQr = (qr: string) => {
  const lines = qr.replace(/\n+$/, '').split('\n');
  const w = Math.max(...lines.map((l) => [...l].length));
  const title = ' bWalletX · scan to pair ';
  const pad = Math.max(0, Math.floor((w - title.length) / 2));
  return [yellow(' '.repeat(pad) + title), ...lines.map((l) => yellow(l))].join('\n') + '\n';
};
