// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SlabScannerHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "SlabScannerHelper",
            path: "Sources/SlabScannerHelper",
            linkerSettings: [
                .linkedFramework("Vision"),
                .linkedFramework("AppKit"),
                .linkedFramework("ImageCaptureCore"),
            ]
        ),
    ]
)
