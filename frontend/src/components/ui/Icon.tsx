import type { SVGProps } from 'react';

/** 線画アイコン。デモ版と同じ名前で呼べるようにしてある。 */
const PATHS: Record<string, string> = {
  dash: 'M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-18v6h8V3h-8z',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-6v.01M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7',
  cart: 'M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.5L21 8H6M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  plus: 'M12 5v14M5 12h14',
  truck: 'M3 7h11v9H3zM14 10h4l3 3v3h-7zM6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  refresh: 'M4 4v6h6M20 20v-6h-6M20 9a8 8 0 0 0-14.5-3M4 15a8 8 0 0 0 14.5 3',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
  dl: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5z',
  doc: 'M6 2h8l6 6v14H6zM14 2v6h6M9 13h6M9 17h6',
  yen: 'M7 4l5 7 5-7M12 11v9M8 14h8M8 17h8',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  tag: 'M3 12l9-9h8v8l-9 9-8-8zM16 8h.01',
  cal2: 'M4 5h16v16H4zM4 10h16M9 3v4M15 3v4',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  db: 'M12 2c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  menu: 'M3 6h18M3 12h18M3 18h18',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2l-4.3-4.3',
  print: 'M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z',
  check: 'M20 6L9 17l-5-5',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  chevron: 'M9 18l6-6-6-6',
  warn: 'M12 9v4m0 4h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  mail: 'M3 5h18v14H3zM3 7l9 6 9-6',
  eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  upload: 'M12 21V9m0 0l-4 4m4-4l4 4M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2',
  clip: 'M21 11.5l-9.2 9.2a5 5 0 0 1-7-7l9.2-9.2a3.3 3.3 0 0 1 4.7 4.7L9.5 18.4a1.7 1.7 0 0 1-2.4-2.4L15.6 7.5',
};

export function Icon({ name, size = 16, ...rest }: { name: string; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      <path d={PATHS[name] ?? PATHS.box} />
    </svg>
  );
}

/** デモ版と同じロゴ（橙の丸に C） */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="16" fill="rgb(233,92,26)" />
      <path
        d="M23.4 11.6C22.7 8.1 19.2 5.6 15.4 5.9C10.1 6.3 6.2 10.4 6 15.6C5.8 20.8 9.2 25.2 14.3 25.8C17.9 26.2 21.1 24.4 22.4 21.3M23.4 11.6C24.3 10.1 24.8 8.8 24.2 7.9C23.6 7.1 22.3 7.4 21.6 8.5"
        stroke="#fff"
        strokeWidth="3.15"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
