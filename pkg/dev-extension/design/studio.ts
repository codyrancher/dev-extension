/**
 * Imported for its side effect, which is the stylesheet.
 *
 * This was the agents extension's own `design/tokens.ts`. It is `studio.ts` here because this
 * package already has a `design/tokens.ts` - the Dev product's space and control scale - and the
 * two are different stylesheets with the same job in two different design systems. Keeping both
 * means a component that came from agents gets the styles it was written against and nothing
 * else changes.
 */
import './studio.css';
