export type CorsoIconName =
  | "home"
  | "learning"
  | "settings"
  | "conversation"
  | "results"
  | "signals"
  | "workspaces"
  | "lesson"
  | "search"
  | "people"
  | "publish"
  | "restore";

export type CorsoIconProps = {
  className?: string;
  name: CorsoIconName;
  size?: number;
  title?: string;
};

function IconPaths({ name }: { name: CorsoIconName }) {
  switch (name) {
    case "home":
      return <path d="M4 10.6 12 4l8 6.6V19a1 1 0 0 1-1 1h-4.6v-5.6H9.6V20H5a1 1 0 0 1-1-1z" />;
    case "learning":
      return (
        <>
          <path d="M4 5.6A1.6 1.6 0 0 1 5.6 4H11v15.4H5.6A1.6 1.6 0 0 1 4 17.8z" />
          <path d="M20 5.6A1.6 1.6 0 0 0 18.4 4H13v15.4h5.4A1.6 1.6 0 0 0 20 17.8z" />
        </>
      );
    case "settings":
      return (
        <>
          <path d="M4 8h9M17.5 8H20M4 16h3.5M12 16h8" />
          <circle cx="15" cy="8" r="2.5" />
          <circle cx="9.5" cy="16" r="2.5" />
        </>
      );
    case "conversation":
      return <path d="M20 15.2a2 2 0 0 1-2 2H8l-4 3.4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />;
    case "results":
      return <path d="M4 19V9M10 19V5M16 19v-6M22 19H2" />;
    case "signals":
      return (
        <>
          <path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5l2.6-1.5M17.2 9l2.6-1.5" />
          <circle cx="12" cy="12" r="3.2" />
        </>
      );
    case "workspaces":
      return (
        <>
          <rect x="3.5" y="4.5" width="7" height="7" rx="2" />
          <rect x="13.5" y="4.5" width="7" height="7" rx="2" />
          <rect x="3.5" y="14.5" width="7" height="5" rx="2" />
          <rect x="13.5" y="14.5" width="7" height="5" rx="2" />
        </>
      );
    case "lesson":
      return <path d="M4 7h16M4 12h16M4 17h9" />;
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </>
      );
    case "people":
      return (
        <>
          <circle cx="12" cy="8" r="3.4" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </>
      );
    case "publish":
      return (
        <>
          <path d="M12 16V5M8.5 8.5 12 5l3.5 3.5" />
          <path d="M4 15v3.4A1.6 1.6 0 0 0 5.6 20h12.8A1.6 1.6 0 0 0 20 18.4V15" />
        </>
      );
    case "restore":
      return (
        <>
          <path d="M20 12a8 8 0 1 1-2.4-5.7" />
          <path d="M20 4v4h-4" />
        </>
      );
  }
}

export function CorsoIcon({
  className,
  name,
  size = 24,
  title,
}: CorsoIconProps) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={className}
      fill="none"
      height={size}
      role={title ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
    >
      <IconPaths name={name} />
    </svg>
  );
}

export default CorsoIcon;
