/**
 * One thing that is running, for the corner docks.
 *
 * Its own file because a `<script setup>` block cannot export a type, and both the component and
 * the page that builds its rows need this one.
 */
export interface DockRow {
  id: string;
  name: string;
  /** Its state, in its own words: `running`, `ready`, `provisioning`. */
  state: string;
  /** Whether it is up, which is the only distinction the dot makes. */
  up: boolean;
  /** Broken, as against merely not up. */
  bad?: boolean;
  /** A word or two more: what it needs, in the words the sidebar uses. */
  note?: string;
  /** How its state should read: the sidebar's own tones. */
  tone?: 'muted' | 'busy' | 'needs' | 'bad' | 'good';
  /** The room it has, when it is the kind of thing that has any. */
  room?: { label: string; fill: string; text: string }[];
}
