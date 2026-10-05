import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Houzz Hills Operations", template: "%s | Houzz Hills" },
  description: "Property operations workspace and online booking.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-NG"><body><main>{children}</main></body></html>;
}
