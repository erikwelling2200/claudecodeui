import { createContext, useContext, useEffect } from 'react';

/**
 * A request to open every collapsed disclosure beneath the provider: each new non-zero value is a new request, 0 is
 * none. The chat module's in-chat find raises it on the message holding the current hit, so a hit inside a folded
 * tool call is shown instead of scrolled to while hidden; the shared Collapsible and chat's own disclosures obey it.
 */
export const DisclosureRevealContext = createContext(0);

/** Runs `open` whenever the enclosing provider issues a new reveal request, including on mount while one stands. */
export function useDisclosureReveal(open: () => void): void {
  const revealRequest = useContext(DisclosureRevealContext);
  useEffect(() => {
    if (revealRequest > 0) open();
  // Only a new request opens; `open` is recreated every render and must not re-open a section the user closed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest]);
}
