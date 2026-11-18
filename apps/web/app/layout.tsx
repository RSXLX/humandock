import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HumanDock — The human review desk",
  description: "Human review, exact-version approval, and transparent settlement for AI-assisted content. Local MVP demonstration.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
