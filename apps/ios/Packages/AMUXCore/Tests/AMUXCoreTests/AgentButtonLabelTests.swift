import XCTest
@testable import AMUXCore

final class AgentButtonLabelTests: XCTestCase {
    func test_zeroSelected_returnsNil() {
        let label = AgentButtonLabel.text(selectedDisplayNamesInOrder: [], totalSelected: 0)
        XCTAssertNil(label)
    }

    func test_oneSelected_returnsName() {
        let label = AgentButtonLabel.text(selectedDisplayNamesInOrder: ["alice"], totalSelected: 1)
        XCTAssertEqual(label, "alice")
    }

    func test_multipleSelected_returnsFirstWithMultiplier() {
        let label = AgentButtonLabel.text(selectedDisplayNamesInOrder: ["alice", "bob"], totalSelected: 2)
        XCTAssertEqual(label, "alice ×2")
    }

    func test_multipleSelected_threeShowsCountThree() {
        let label = AgentButtonLabel.text(selectedDisplayNamesInOrder: ["alice", "bob", "carol"], totalSelected: 3)
        XCTAssertEqual(label, "alice ×3")
    }
}
