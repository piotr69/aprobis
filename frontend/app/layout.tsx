import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Aprobis",
  description: "Aprobis — elektroniczny obieg i akceptacja dokumentów w firmie"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl">
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
