import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpaceMatch Addis | Roommate Matching & Housing Ecosystem",
  description: "Primary roommate matching and room rentals for Addis Ababa with Fayda National ID verification.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
    >
      <head>
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
        />
      </head>
      <body className="min-h-full flex flex-col bg-[#090d16] text-white font-sans">
        {children}
      </body>
    </html>
  );
}
