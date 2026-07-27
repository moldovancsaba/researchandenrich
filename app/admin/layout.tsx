import { Inter } from "next/font/google";
import "@mantine/core/styles.css";
import "@sovereignsquad/gds-theme/styles.css";
import "./globals.css";
import { PwaSetup } from "./components/PwaSetup";
import { Providers } from "./components/Providers";
import Link from "next/link";

export const metadata = {
  title: {
    template: "%s · Sales Lead Generator",
    default: "Sales Lead Generator",
  },
  description: "AI-powered sales lead collection platform" };

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable} data-gds-theme-preset="default">
      <body className="bg-gray-50 min-h-screen">
        <nav className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 py-3 sm:px-6 lg:px-8 flex items-center justify-between">
            <div className="flex items-center gap-6">
              <Link href="/" className="text-lg font-bold text-gray-900">Sales Lead Generator</Link>
              <Link href="/admin" className="text-sm text-gray-600 hover:text-gray-900">Admin</Link>
            </div>
          </div>
        </nav>
        <main>{children}</main>
        <PwaSetup />
      </body>
    </html>
  )
}
