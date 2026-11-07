// People's own pictures (assets/people), drawn locally: no picture is fetched from anywhere. His is assets/people/alex.png
// (or .jpg, .jpeg, .webp), a square he gives; until it is there, his badge is the person icon on a tile.
import { iconUrl } from './toolIcons';

const files = import.meta.glob<string>('../../../../assets/people/*.{png,jpg,jpeg,webp}', { eager: true, import: 'default' });

/** His picture, when he has put one in assets/people. */
export const HIS_AVATAR: string | undefined = Object.entries(files).find(([path]) => /\/alex\.(png|jpe?g|webp)$/.test(path))?.[1];

/** The person icon his badge falls back to: never a letter. */
export const PERSON_ICON = iconUrl('lucide/user.svg');
