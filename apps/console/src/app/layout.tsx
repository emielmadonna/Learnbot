import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "LearningBot",
    template: "%s · LearningBot",
  },
  description:
    "Private, grounded learning conversations, courses, voice, progress, and administration for modern teams.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
