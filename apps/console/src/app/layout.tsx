import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { PreviewNavigator } from "./preview-navigator";

export const metadata: Metadata = {
  title: "Course AI Platform",
  description: "Unified learning, assistant and tenant operations."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <PreviewNavigator />
      </body>
    </html>
  );
}
