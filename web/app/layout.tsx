import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Prismaxim — Stem Splitter & Studio',
  description:
    'Extract audio from YouTube or a file, split it into stems with Demucs, and remix in a studio-style multitrack editor.',
};

// `viewport-fit=cover` lets the layout extend under the notch/home indicator
// (we pad with env(safe-area-inset-*) in globals.css). `userScalable: false`
// stops the browser's pinch-zoom from fighting the editor's own pinch gestures.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  userScalable: false,
  themeColor: '#0b0d10',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
