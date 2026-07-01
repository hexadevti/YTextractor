import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'YTextractor — Stem Splitter & Studio Mixer',
  description:
    'Extract audio from YouTube or a file, split it into stems with Demucs, and remix in a studio-style browser mixer.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
