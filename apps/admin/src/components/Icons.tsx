import type { ReactNode } from 'react';

export type IconName =
  | 'organization'
  | 'members'
  | 'knowledge'
  | 'agent'
  | 'blueprint'
  | 'business'
  | 'runtime'
  | 'password'
  | 'logout'
  | 'plus'
  | 'refresh'
  | 'settings'
  | 'menu';

export function Icon({ name, size = 20 }: { name: IconName; size?: number }): ReactNode {
  const paths: Record<IconName, ReactNode> = {
    organization: (
      <>
        <rect x="9" y="3" width="6" height="5" rx="1" />
        <rect x="3" y="16" width="6" height="5" rx="1" />
        <rect x="15" y="16" width="6" height="5" rx="1" />
        <path d="M12 8v4M6 16v-4h12v4" />
      </>
    ),
    members: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3.5 19c.4-3.3 2.2-5 5.5-5s5.1 1.7 5.5 5M15 5.5a3 3 0 0 1 0 5.8M16 14c2.7.4 4.2 2.1 4.5 5" />
      </>
    ),
    knowledge: (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11a2 2 0 0 1 2 2v16a3 3 0 0 0-3-3H4z" />
        <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H15a2 2 0 0 0-2 2v16a3 3 0 0 1 3-3h4z" />
      </>
    ),
    agent: (
      <>
        <rect x="4" y="6" width="16" height="13" rx="4" />
        <path d="M9 11h.01M15 11h.01M9 15h6M12 6V3M10 3h4" />
      </>
    ),
    blueprint: (
      <>
        <path d="M5 3h10l4 4v14H5z" />
        <path d="M15 3v5h5M8 12h8M8 16h8M8 8h3" />
      </>
    ),
    business: (
      <>
        <circle cx="5" cy="12" r="2" />
        <circle cx="12" cy="6" r="2" />
        <circle cx="19" cy="12" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="m6.7 10.9 3.6-3.8M13.7 7.1l3.6 3.8M17.3 13.1l-3.6 3.8M10.3 16.9l-3.6-3.8" />
      </>
    ),
    runtime: (
      <>
        <path d="M4 6h16M4 12h16M4 18h16" />
        <circle cx="8" cy="6" r="2" />
        <circle cx="16" cy="12" r="2" />
        <circle cx="11" cy="18" r="2" />
      </>
    ),
    password: (
      <>
        <circle cx="8" cy="12" r="4" />
        <path d="M12 12h9M18 12v3M15 12v2" />
      </>
    ),
    logout: <path d="M10 4H5v16h5M14 8l4 4-4 4M8 12h10" />,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: (
      <path d="M20 7v5h-5M4 17v-5h5M18.5 9A7 7 0 0 0 6 6.5L4 9M5.5 15A7 7 0 0 0 18 17.5l2-2.5" />
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
      </>
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  };
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
