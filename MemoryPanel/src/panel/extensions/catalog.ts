import { vtcExtension } from '../../extensions/vtc/index.js';
import type { PanelExtension } from './types.js';

/** The only core file that imports extension code. */
// The catalog holds extensions with different config types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CATALOG: PanelExtension<any>[] = [vtcExtension];
