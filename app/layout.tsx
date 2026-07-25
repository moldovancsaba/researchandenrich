import type { Metadata } from "next"
import { Inter } from "next/font/google"
import "./globals.css"

const inter = Inter({ subsets: ["latin"] })

export const metadata: Metadata = {
  title: "ContentCreator Admin",
  description: "Admin panel for the ContentCreator research and enrichment system",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <nav className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 py-3 sm:px-6 lg:px-8">
            <Link href="/admin" className="text-lg font-bold text-gray-900 hover:text-indigo-600">
              ContentCreator Admin
            </Link>
          </div>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  )
}
