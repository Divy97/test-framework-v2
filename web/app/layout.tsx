import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Test Framework v2',
  // THE SAME CLAIM THE PAGE MAKES (10n). This kept the headline's old wording — "proves
  // the bug existed" — after the headline itself was corrected for describing a third of
  // what a run does. It is the version a link preview and a search result show, so the
  // one sentence most people read first was the one that had been decided against, and
  // nothing pointed at it: it lives in the document metadata, not in the component whose
  // copy every test asserts. Found by curling the deployed page.
  description:
    'Open an issue, get a pull request that fixes the bug and proves the fix. It reproduces the bug first, in a sealed container; if it cannot, it opens nothing.',
};

/**
 * The document.
 *
 * `lang` is here and not optional: without it a screen reader reads English prose with
 * whatever voice the user's system defaults to, which for a non-English default is
 * unintelligible rather than merely wrong.
 *
 * No font is fetched. The stack is the reader's own serif and their own monospace, which
 * costs no request, cannot flash, and cannot fail closed to a fallback nobody tested. The
 * typographic argument this product makes — human words in a serif, machine facts in a
 * monospace — survives being made in Georgia and Menlo.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
