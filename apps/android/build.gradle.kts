plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
    alias(libs.plugins.detekt)
}

allprojects {
    plugins.withId("io.gitlab.arturbosch.detekt") {
        extensions.configure<io.gitlab.arturbosch.detekt.extensions.DetektExtension> {
            config.setFrom(files("$rootDir/config/detekt/detekt.yml"))
            buildUponDefaultConfig = true
            allRules = false
        }
    }

    // AGP 8.6.1's bundled Lint trips its own
    // `ComposableUtilsKt.isComposable` analyzer with an
    // `IllegalArgumentException` ("incompatible kotlinx-metadata version")
    // on Kotlin 2.1.0 metadata. The crash is internal to Lint
    // (`[LintError]`), not a code-level lint finding. Disabling the
    // meta-check on every Android module so `./gradlew lint` does not
    // fail on a tool bug; revisit once AGP bundles a 2.1-compatible
    // kotlinx-metadata.
    plugins.withId("com.android.library") {
        extensions.configure<com.android.build.api.dsl.LibraryExtension>("android") {
            lint { disable += "LintError" }
        }
    }
    plugins.withId("com.android.application") {
        extensions.configure<com.android.build.api.dsl.ApplicationExtension>("android") {
            lint { disable += "LintError" }
        }
    }
}
