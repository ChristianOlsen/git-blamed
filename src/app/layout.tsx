import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gitblamed. — Good friends. Bad commits.",
  description:
    "A no-context commit guessing game. Gather your friends, read the commit, point at the culprit.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0d1117",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
