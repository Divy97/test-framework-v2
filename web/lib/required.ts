/**
 * Which values a recipe requires and nobody has stored.
 *
 * The browser's half of `missingRequired` in `src/recipe.ts`, and deliberately a copy
 * rather than an import: that module pulls in the recipe parser and its dependencies, and
 * this bundle is built by a different toolchain into an artifact that must not carry the
 * engine. The rule is four lines and `test/screens.test.tsx` asserts the two agree.
 *
 * It exists at all because nothing compared these two lists until a run was already
 * going. The recipe NAMES what it needs; the run stopped, correctly, and came back
 * blocked — after the person had chosen an issue and pressed Start.
 */
export const missingNames = (
  recipe: { required?: string[]; env?: Record<string, string> } | null,
  stored: readonly string[],
): string[] =>
  (recipe?.required ?? [])
    // An EMPTY value does not satisfy a required name, for the reason `src/recipe.ts`
    // records: an agent that cannot find a value and must not invent one could otherwise
    // write `""` and unblock the run into the half-configured boot the field prevents.
    .filter((name) => (recipe?.env ?? {})[name] === undefined || (recipe?.env ?? {})[name] === '')
    .filter((name) => !stored.includes(name));
