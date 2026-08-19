// The scale itself. Imported here rather than from a component, so it lands in the bundle once
// and every layout component gets it by importing the module it already imports.
import './tokens.css';

/**
 * The space scale, for the components that take a step of it as a prop.
 *
 * The values themselves live in tokens.css. This file only knows the names, because a component
 * that took `gap="4"` and turned it into `10px` here would be a second place for the scale to be
 * defined, and the two would eventually disagree.
 */
export const SPACE = [1, 2, 3, 4, 5, 6];

export type Space = 1 | 2 | 3 | 4 | 5 | 6;

/** The custom property for a step, or `0` for no gap at all. */
export function spaceVar(step: string | number): string {
  const value = Number(step);

  return SPACE.includes(value) ? `var(--dev-space-${ value })` : '0';
}

/** Control heights, by the same rule: named here, valued in the stylesheet. */
export const CONTROL = ['row', 'sm', 'md'];

export function controlVar(size: string): string {
  return { row: 'var(--dev-control-row)', sm: 'var(--dev-control-sm)', md: 'var(--dev-control)' }[size] || 'auto';
}
