import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Property Operations",
  description: "Houzz Hills staff and property operations workspace.",
  robots: { index: false, follow: false },
};

export default function ManagementLayout({ children }: { children: React.ReactNode }) { return children; }
