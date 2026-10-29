// The portrait pack bundled with the client (assets/portraits/default).
import { packFromFiles, type Pack } from './portraits';

const files = import.meta.glob('../assets/portraits/default/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const DEFAULT_PACK: Pack = packFromFiles(files);
