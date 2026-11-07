// The API calls this plugin must NEVER contain (acceptance criterion 23 of the spec): it
// does not trash, move, rename or create anything, and it does not save notes behind the
// user's back. Shared by the build guard (`build-hebra.mjs`, which fails the build) and by
// `tests/bundle.test.ts`, which also proves the scan fails when one of them shows up.
export const FORBIDDEN_CALLS = [
  'noteTrash',
  'fileTrash',
  'folderTrashEmpty',
  'noteMove',
  'folderRename',
  'folderMove',
  'folderCreate',
  'noteCreate',
  'noteSave',
  // Variantes con guarda (N1) y reemplazo de ficheros.
  'noteTrashIfUnchanged',
  'noteMoveIfUnchanged',
  'folderRenameIfUnchanged',
  'fileReplace'
];

/** The forbidden names found in `text` as whole identifiers (empty list = clean). The scan
 *  is over the raw text, comments and strings included: the strictest reading of «must not
 *  appear». */
export function findForbiddenCalls(text) {
  return FORBIDDEN_CALLS.filter((name) => new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`).test(text));
}
