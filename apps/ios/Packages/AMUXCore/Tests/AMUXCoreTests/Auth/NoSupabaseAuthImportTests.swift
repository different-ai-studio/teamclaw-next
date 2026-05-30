import XCTest

final class NoSupabaseAuthImportTests: XCTestCase {
    func testAuthModuleDoesNotImportSupabase() throws {
        let pkgRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Auth/
            .deletingLastPathComponent()  // AMUXCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // <pkg root>
        let authDir = pkgRoot.appendingPathComponent("Sources/AMUXCore/CloudAPI/Auth")
        let files = try FileManager.default.contentsOfDirectory(at: authDir, includingPropertiesForKeys: nil)
        let swiftFiles = files.filter { $0.pathExtension == "swift" }
        XCTAssertFalse(swiftFiles.isEmpty, "expected Swift files under \(authDir.path)")
        for file in swiftFiles {
            let contents = try String(contentsOf: file, encoding: .utf8)
            XCTAssertFalse(contents.contains("import Supabase"),
                           "\(file.lastPathComponent) must not import Supabase — the CloudAPI auth module is SDK-free")
        }
    }
}
