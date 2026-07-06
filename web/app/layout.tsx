import type { Metadata, Viewport } from 'next';
import { IS_MOBILE } from '@/lib/env';
import './globals.css';

export const metadata: Metadata = {
  title: 'Prismaxim — Stem Splitter & Studio',
  description:
    'Extract audio from YouTube or a file, split it into stems with Demucs, and remix in a studio-style multitrack editor.',
  // Favicon points at the single public/icon.png. We deliberately don't use the
  // App Router `app/icon.png` metadata-file convention: it also serves the image
  // at /icon.png, which collides with public/icon.png (the sidebar logo's src)
  // and makes Next return 500 for that path ("conflicting public file and page file").
  icons: { icon: '/icon.png' },
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
    <html lang="en" className={IS_MOBILE ? 'is-mobile' : undefined}>
      <body>{children}</body>
    </html>
  );
}
