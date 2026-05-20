package tech.teamclaw.android.core.model

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SearchMatcherTest {

    @Test fun `blank query never matches`() {
        assertFalse(SearchMatcher.matches("anything", ""))
        assertFalse(SearchMatcher.matches("anything", "   "))
    }

    @Test fun `case-insensitive substring matches`() {
        assertTrue(SearchMatcher.matches("Quiet Harbor", "harbor"))
        assertTrue(SearchMatcher.matches("Quiet Harbor", "QUIET"))
    }

    @Test fun `diacritic-insensitive matches`() {
        // NFD-fold handles combining-mark diacritics (é = e + ◌́). It does
        // *not* handle code points that don't decompose (Ł, ø, ß), unlike
        // iOS Foundation's broader `.diacriticInsensitive` option; if we
        // need parity on those we'll have to ship a per-character fold
        // table.
        assertTrue(SearchMatcher.matches("café", "cafe"))
        assertTrue(SearchMatcher.matches("naïve résumé", "naive resume"))
    }

    @Test fun `non-match returns false`() {
        assertFalse(SearchMatcher.matches("Quiet Harbor", "xyz"))
    }

    @Test fun `matchesAny finds any matching field`() {
        val fields = listOf("Quiet Harbor", "team chat")
        assertTrue(SearchMatcher.matchesAny(fields, "team"))
        assertTrue(SearchMatcher.matchesAny(fields, "harbor"))
        assertFalse(SearchMatcher.matchesAny(fields, "missing"))
    }

    @Test fun `query whitespace is trimmed`() {
        assertTrue(SearchMatcher.matches("Quiet Harbor", "  harbor  "))
    }
}
