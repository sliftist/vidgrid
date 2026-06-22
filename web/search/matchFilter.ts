// Local search-filter that improves on sliftutils' version with
// punctuation-tolerant substring matching.
//
// Behaviour:
//   - Top-level `|` is OR. Each side splits on `&` for AND.
//   - Each AND term may start with `!` for negation.
//   - For each leaf term, after &/|/! parsing: if the term contains no
//     "special" characters (anything other than letters, digits, or
//     spaces) we strip ALL non-alphanumeric chars from BOTH the term
//     and the value before testing `includes` — so "Silence of" matches
//     "silence.of" or "silence-of".
//   - If the term DOES contain special characters (e.g. ".", "-"), we
//     respect them literally and fall back to a plain `includes`.
//
// This is just the leaf-level rule. The boolean parser stays identical
// to sliftutils' so the user's habit with `&` / `|` / `!` keeps working.

const NON_ALNUM = /[^a-z0-9]/g;
const HAS_SPECIAL = /[^a-z0-9\s]/;

export function matchFilter(filter: { value: string }, value: string): boolean {
    const raw = filter.value.toLowerCase().trim();
    if (!raw) return true;
    const v = value.toLowerCase().trim();
    const stripped = v.replace(NON_ALNUM, "");
    return raw.split("|").some(orPart =>
        orPart.split("&").every(andPart => {
            const trimmed = andPart.trim();
            const negate = trimmed.startsWith("!");
            const leaf = (negate ? trimmed.slice(1) : trimmed).trim();
            const hit = leafMatches(leaf, v, stripped);
            return negate ? !hit : hit;
        })
    );
}

function leafMatches(leaf: string, value: string, stripped: string): boolean {
    if (!leaf) return true;
    if (HAS_SPECIAL.test(leaf)) {
        // User typed punctuation on purpose — keep it literal.
        return value.includes(leaf);
    }
    // No punctuation in the query → ignore punctuation in the haystack.
    const strippedLeaf = leaf.replace(NON_ALNUM, "");
    if (!strippedLeaf) return true;
    return stripped.includes(strippedLeaf);
}
