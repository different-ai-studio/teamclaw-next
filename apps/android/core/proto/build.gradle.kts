plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.wire)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin { jvmToolchain(17) }

wire {
    sourcePath {
        srcDir(rootProject.file("../../proto"))
    }
    kotlin {
        javaInterop = false
        out = layout.buildDirectory.dir("generated/source/wire").get().asFile.path
    }
}

dependencies {
    api(libs.wire.runtime)
}
