import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EchoPDF | Industry-Level Voice AI & RAG",
  description: "The next generation of PDF interaction. Powered by Groq, Pinecone, and Advanced Reranking.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@400;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased selection:bg-primary/30">
        {children}
      </body>
    </html>
  );
}
