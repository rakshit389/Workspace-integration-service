import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PanelDefinition } from './types.js';

const PANEL_FILE = /\.panel\.(ts|js)$/;

/** Discovers every `*.panel.ts` (or compiled `.js`) file in this folder and returns the panels in sidebar order. */
export async function loadPanels(directory = dirname(fileURLToPath(import.meta.url))): Promise<PanelDefinition[]> {
  const files = (await readdir(directory)).filter((file) => PANEL_FILE.test(file)).sort();
  const panels: PanelDefinition[] = [];
  for (const file of files) {
    const module = (await import(pathToFileURL(join(directory, file)).href)) as { default?: PanelDefinition };
    const panel = module.default;
    if (!panel || typeof panel.id !== 'string' || typeof panel.load !== 'function' || typeof panel.isPermitted !== 'function') {
      throw new Error(`${file} must default-export a PanelDefinition`);
    }
    if (panels.some((existing) => existing.id === panel.id)) throw new Error(`Duplicate panel id "${panel.id}" in ${file}`);
    panels.push(panel);
  }
  return panels.sort((a, b) => a.order - b.order);
}
