import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Test Framework v2',
  description:
    'An event-sourced verification engine. Open an issue, get back a pull request that proves the bug existed.',
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
