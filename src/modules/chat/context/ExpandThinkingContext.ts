import { createContext, useContext } from 'react';

/**
 * The composer's "expand all thinking" toggle. Every thinking section opens
 * when it turns on and closes when it turns off; in between, each one can still
 * be opened or closed by hand.
 */
export const ExpandThinkingContext = createContext<boolean>(false);

export function useExpandThinking(): boolean {
  return useContext(ExpandThinkingContext);
}
