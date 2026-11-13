import { createContext } from 'react';

/** The element in the editor header that file-type buttons are portalled into; null until the header has mounted. */
export const HeaderActionsSlotContext = createContext<HTMLElement | null>(null);

/** The look shared by every header button, so file-type buttons match the layout toggles. */
export const headerButtonClassName = 'flex items-center justify-center rounded-md p-1.5 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white';

/** A header button that is switched on, such as the markdown preview while it shows. */
export const headerButtonActiveClassName = 'flex items-center justify-center rounded-md p-1.5 transition-colors bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400';
