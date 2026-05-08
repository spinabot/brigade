/**
 * Shared Pi-TUI themes for Brigade.
 *
 * One canonical place so onboarding + chat feel like the same app.
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@mariozechner/pi-tui";
import chalk from "chalk";

export const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.hex("#fbbf24")(s), // amber
  link: (s) => chalk.hex("#60a5fa")(s),
  linkUrl: (s) => chalk.dim(s),
  code: (s) => chalk.hex("#fde7c4")(s),
  codeBlock: (s) => chalk.hex("#a7f3d0")(s),
  codeBlockBorder: (s) => chalk.dim.hex("#92400e")(s),
  quote: (s) => chalk.italic.hex("#fde7c4")(s),
  quoteBorder: (s) => chalk.dim.hex("#92400e")(s),
  hr: (s) => chalk.dim(s),
  listBullet: (s) => chalk.hex("#fbbf24")(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
};

export const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.dim(s),
  selectList: {
    selectedPrefix: (s) => chalk.hex("#fbbf24")(s),
    selectedText: (s) => chalk.bold(s),
    description: (s) => chalk.dim(s),
    scrollInfo: (s) => chalk.dim(s),
    noMatch: (s) => chalk.dim(s),
  },
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (s) => chalk.hex("#fbbf24")(s),
  selectedText: (s) => chalk.bold(s),
  description: (s) => chalk.dim(s),
  scrollInfo: (s) => chalk.dim(s),
  noMatch: (s) => chalk.dim("  No matching option"),
};

/** Brand color helpers (used for status bars, dividers, accents). */
export const brand = {
  amber: (s: string) => chalk.hex("#fbbf24")(s),
  amberDeep: (s: string) => chalk.hex("#92400e")(s),
  dim: (s: string) => chalk.dim(s),
  white: (s: string) => chalk.white(s),
  user: (s: string) => chalk.bold.hex("#60a5fa")(s),
  agent: (s: string) => chalk.bold.hex("#fbbf24")(s),
  tool: (s: string) => chalk.hex("#a7f3d0")(s),
  error: (s: string) => chalk.bold.hex("#fca5a5")(s),
};
