"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function PreviewNavigator() {
  const pathname = usePathname();

  if (!pathname.startsWith("/dev/")) {
    return null;
  }

  return (
    <Link className="previewNavigator" href="/" aria-label="Open all product surfaces">
      <span aria-hidden="true">L</span>
      All surfaces
    </Link>
  );
}
