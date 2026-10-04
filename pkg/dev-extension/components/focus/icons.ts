/** The icon set's names and paths, apart from the component so both can import them. */
export type IconName =
  | 'settings' | 'tasks' | 'send' | 'chevron-up' | 'chevron-down'
  | 'check' | 'cross' | 'spinner' | 'play' | 'sparkle' | 'clock' | 'arrow-right'
  | 'pencil' | 'expand' | 'chevron-left' | 'chevron-right' | 'plus' | 'minus'
  | 'pin' | 'snooze' | 'scales' | 'copy' | 'trash' | 'server'
  | 'grid' | 'image';

export const iconPaths: Record<IconName, string> = {
  // A pin, pointing down-left, as a drawing pin seen from the side.
  pin: 'M12.2 2.4 17.6 7.8M13.4 3.6 9.9 7.1a4.6 4.6 0 0 0-3.9.9l6 6a4.6 4.6 0 0 0 .9-3.9l3.5-3.5M8.2 11.8 3.4 16.6',
  // A clock with its hands set a little later: put off, not stopped.
  snooze: 'M10 4.4a5.6 5.6 0 1 0 5.6 5.6M10 6.8V10l2.4 1.6M12.6 2.6h4.8l-4.8 4.4h4.8',
  // A balance: the weights, which is what the panel it labels is for.
  scales: 'M10 3.2v13.2M5.4 16.4h9.2M3 7.4h14M3 7.4 5.6 12.6h-5.2zM17 7.4l2.6 5.2h-5.2z',
  settings:
    'M10 1.8a1.2 1.2 0 0 0-1.2 1.2v.7a6.3 6.3 0 0 0-1.5.9l-.6-.35a1.2 1.2 0 0 0-1.64.44l-.6 1.04a1.2 1.2 0 0 0 .44 1.64l.6.35a6.3 6.3 0 0 0 0 1.74l-.6.35a1.2 1.2 0 0 0-.44 1.64l.6 1.04a1.2 1.2 0 0 0 1.64.44l.6-.35c.46.37.97.67 1.5.9v.7a1.2 1.2 0 0 0 1.2 1.2h1.2a1.2 1.2 0 0 0 1.2-1.2v-.7c.53-.23 1.04-.53 1.5-.9l.6.35a1.2 1.2 0 0 0 1.64-.44l.6-1.04a1.2 1.2 0 0 0-.44-1.64l-.6-.35a6.3 6.3 0 0 0 0-1.74l.6-.35a1.2 1.2 0 0 0 .44-1.64l-.6-1.04a1.2 1.2 0 0 0-1.64-.44l-.6.35a6.3 6.3 0 0 0-1.5-.9V3a1.2 1.2 0 0 0-1.2-1.2Zm.6 10.6a2.4 2.4 0 1 1 0-4.8 2.4 2.4 0 0 1 0 4.8Z',
  tasks:
    'M3 4.6h2.4l1.2 1.4 2.6-2.8M3 10h2.4l1.2 1.4L9.2 8.6M3 15.4h2.4l1.2 1.4 2.6-2.8M11.6 5h5.4M11.6 10.4h5.4M11.6 15.8h5.4',
  send:
    'M2.6 9.9 16.8 3.4a.4.4 0 0 1 .53.53L10.9 18.1a.4.4 0 0 1-.74-.03l-1.7-4.9-4.9-1.7a.4.4 0 0 1-.03-.74Z',
  'chevron-up': 'm5 12 5-5 5 5',
  'chevron-down': 'm5 8 5 5 5-5',
  check: 'm4.5 10.2 3.4 3.4 7.6-7.6',
  cross: 'm5.5 5.5 9 9m0-9-9 9',
  spinner: 'M10 2.6a7.4 7.4 0 1 0 7.4 7.4',
  play: 'M7.4 4.8v10.4L16 10Z',
  sparkle:
    'M10 2.4 11.7 7 16.3 8.7 11.7 10.4 10 15 8.3 10.4 3.7 8.7 8.3 7ZM15.6 13.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7Z',
  clock: 'M10 5.2V10l3 1.8M17.4 10a7.4 7.4 0 1 1-14.8 0 7.4 7.4 0 0 1 14.8 0Z',
  'arrow-right': 'M4 10h11.4m0 0-4-4m4 4-4 4',
  pencil: 'M13.1 3.9a1.7 1.7 0 0 1 2.4 2.4L6.9 14.9l-3.2.8.8-3.2ZM11.8 5.2l2.4 2.4',
  expand: 'M12 3.4h4.6V8M8 16.6H3.4V12M16.6 3.4 11.2 8.8M3.4 16.6l5.4-5.4',
  'chevron-left': 'm12 5-5 5 5 5',
  'chevron-right': 'm8 5 5 5-5 5',
  plus: 'M10 4.6v10.8M4.6 10h10.8',
  minus: 'M4.6 10h10.8',
  // Two sheets, the back one offset: the copy mark everything uses.
  copy: 'M7.4 7.4h7.8v7.8H7.4zM12.6 7.4V5.2a1 1 0 0 0-1-1H5.2a1 1 0 0 0-1 1v6.4a1 1 0 0 0 1 1h2.2',
  // A bin with a lid and two staves.
  trash: 'M4.6 6.6h10.8M8.2 6.6V4.8h3.6v1.8M6.2 6.6l.7 9.2h6.2l.7-9.2M8.8 9.4v3.8M11.2 9.4v3.8',
  // A stack of two boxes with a light on each: a running thing, as against a static one.
  server: 'M3.6 4.4h12.8v4.4H3.6zM3.6 11.2h12.8v4.4H3.6zM6.2 6.6h.01M6.2 13.4h.01',
  // Four panes: the set, as against the one of it you are looking at. The media viewer's way back.
  grid: 'M3.6 3.6h5.4v5.4H3.6zM11 3.6h5.4v5.4H11zM3.6 11h5.4v5.4H3.6zM11 11h5.4v5.4H11z',
  // A frame with a horizon and a sun in it: a still, as against the `play` of a recording.
  image: 'M3.6 4.4h12.8v11.2H3.6zM3.6 12.6l3.4-3 2.8 2.4 2.8-3 3.8 3.6M12.8 7.8h.01',
};

/** The ones drawn as a solid shape rather than a stroked line. */
export const filledIcons: IconName[] = ['send', 'play', 'sparkle', 'settings'];
