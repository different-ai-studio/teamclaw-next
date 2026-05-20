package tech.teamclaw.android.core.model

import java.text.Normalizer

/**
 * Pure matching helpers for the global Search tab — port of iOS
 * `apps/ios/Packages/AMUXCore/Sources/AMUXCore/Search/SearchMatcher.swift`.
 * No state, no I/O. Case- and diacritic-insensitive substring match.
 *
 * `query` blank → false; callers decide what blank means (typically "show
 * the search prompt, not all rows").
 */
object SearchMatcher {

    fun matches(haystack: String, query: String): Boolean {
        val q = query.trim()
        if (q.isEmpty()) return false
        return fold(haystack).contains(fold(q))
    }

    fun matchesAny(fields: List<String>, query: String): Boolean =
        fields.any { matches(it, query) }

    /**
     * NFD-normalize, strip combining marks (diacritics), lowercase. Mirrors
     * the Foundation `[.caseInsensitive, .diacriticInsensitive]` options
     * iOS uses in `String.range(of:options:)`.
     */
    private fun fold(text: String): String {
        val nfd = Normalizer.normalize(text, Normalizer.Form.NFD)
        val sb = StringBuilder(nfd.length)
        for (ch in nfd) {
            if (Character.getType(ch) != Character.NON_SPACING_MARK.toInt()) {
                sb.append(ch)
            }
        }
        return sb.toString().lowercase()
    }
}
