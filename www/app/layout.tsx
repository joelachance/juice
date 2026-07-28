import type { Metadata } from "next";
import { f1Wide, berkeleyMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Juice — simple secrets management",
  description: "Agent secrets without copy/paste.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${f1Wide.variable} ${berkeleyMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
