"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import styles from "./workspace-shell.module.css";

type WorkspaceShellProps = {
  children: ReactNode;
  className?: string;
  active?: "home" | "learning" | "people" | "preview" | "admin" | "settings";
};

const primaryNavigation = [
  { id: "home", label: "Home", href: "/" },
  { id: "learning", label: "Learning", href: "/dev/learning" },
  { id: "people", label: "People & signals", href: "/dev/creator" },
  { id: "preview", label: "Client preview", href: "/dev/chat" },
  { id: "admin", label: "Admin", href: "/dev/admin" },
] as const;

function inferredActive(pathname: string): WorkspaceShellProps["active"] {
  if (pathname === "/") return "home";
  if (pathname.includes("/learning")) return "learning";
  if (pathname.includes("/creator") || pathname.includes("/teacher") || pathname.includes("/intelligence")) return "people";
  if (pathname.includes("/chat")) return "preview";
  if (pathname.includes("/branding")) return "settings";
  return "admin";
}
export default function WorkspaceShell({ children, className, active }: WorkspaceShellProps) {
  const pathname = usePathname();
  const current = active ?? inferredActive(pathname);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link className={styles.identity} href="/" aria-label="Estie workspace home">
          <span className={styles.mark}>E</span>
          <span className={styles.identityText}>
            <strong>Estie</strong>
            <small>Estie Starr</small>
          </span>
        </Link>

        <nav className={styles.primaryNav} aria-label="Primary navigation">
          {primaryNavigation.map((item) => (
            <Link
              className={current === item.id ? styles.active : ""}
              href={item.href}
              aria-current={current === item.id ? "page" : undefined}
              key={item.id}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className={styles.accountArea}>
          <Link className={current === "settings" ? styles.settingsActive : styles.settings} href="/dev/branding">
            Settings
          </Link>
          <span className={styles.accountAvatar}>ES</span>
        </div>
      </header>

      <div className={`${styles.content} ${className ?? ""}`}>{children}</div>
    </div>
  );
}
