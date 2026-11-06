/**
 * How many directory levels below what is on screen the file tree loads ahead.
 * 1 means every visible folder's contents are already loaded when it is
 * expanded, so the expand is instant. Raise it when expanding several levels
 * in quick succession still waits on the server.
 */
export const FILE_TREE_PREFETCH_DEPTH = 1;

// Results shown by the tree's search box; the server ranks them, so these are the best ones.
export const FILE_TREE_SEARCH_LIMIT = 500;

export const FILE_TREE_SEARCH_DEBOUNCE_MS = 120;
