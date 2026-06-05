// SlabScannerHelper — WebSocket server for Slab Scanner web app
// Provides Apple Vision OCR + Epson V600 scanner control over ws://127.0.0.1:7878
// No external dependencies — uses Apple's Network framework for WebSocket.

import Foundation
import Network
import Vision
import AppKit
import ImageCaptureCore

// ─── Configuration ────────────────────────────────────────────────────────────

let PORT: UInt16 = 7878
let ALLOWED_ORIGINS: Set<String> = {
    var origins: Set<String> = [
        "http://localhost",
        "http://127.0.0.1",
        "null"  // file:// sends "null" as origin
    ]
    // Add any port variants for local dev
    for port in [3000, 5500, 8000, 8080, 8765] {
        origins.insert("http://localhost:\(port)")
        origins.insert("http://127.0.0.1:\(port)")
    }
    // Add configured origin from env
    if let custom = ProcessInfo.processInfo.environment["SLABSCANNER_ALLOWED_ORIGIN"] {
        origins.insert(custom)
    }
    return origins
}()

// ─── Logging ──────────────────────────────────────────────────────────────────

let logDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/SlabScannerHelper")
let logFile = logDir.appendingPathComponent("helper.log")

func setupLogging() {
    try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
}

func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[\(ts)] \(msg)\n"
    print(line, terminator: "")
    if let data = line.data(using: .utf8) {
        if FileManager.default.fileExists(atPath: logFile.path) {
            if let fh = try? FileHandle(forWritingTo: logFile) {
                fh.seekToEndOfFile()
                fh.write(data)
                fh.closeFile()
            }
        } else {
            try? data.write(to: logFile)
        }
    }
}

// ─── Vision OCR ───────────────────────────────────────────────────────────────

func recognizeText(imageData: Data) -> (text: String, confidence: Double) {
    guard let image = NSImage(data: imageData),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return ("", 0)
    }

    var results: [String] = []
    var totalConf: Double = 0
    let semaphore = DispatchSemaphore(value: 0)

    let request = VNRecognizeTextRequest { req, error in
        defer { semaphore.signal() }
        guard let observations = req.results as? [VNRecognizedTextObservation] else { return }
        for obs in observations {
            if let top = obs.topCandidates(1).first {
                results.append(top.string)
                totalConf += Double(top.confidence)
            }
        }
    }
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try? handler.perform([request])
    semaphore.wait()

    let text = results.joined(separator: "\n")
    let avgConf = results.isEmpty ? 0 : totalConf / Double(results.count)
    return (text, avgConf)
}

// ─── Scanner Controller ──────────────────────────────────────────────────────

class ScannerController: NSObject, ICDeviceBrowserDelegate, ICScannerDeviceDelegate {
    let browser = ICDeviceBrowser()
    var scanner: ICScannerDevice?
    var scanDPI: Int = 600
    let jpegQuality: Double = 0.92
    var onScannerFound: ((String) -> Void)?
    var onScannerRemoved: (() -> Void)?
    var onScanComplete: ((Data) -> Void)?
    var onScanError: ((String) -> Void)?
    var onScanProgress: ((String) -> Void)?

    override init() {
        super.init()
        browser.delegate = self
    }

    func startBrowsing() {
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue:
            ICDeviceTypeMask.scanner.rawValue | ICDeviceLocationTypeMask.local.rawValue)!
        browser.start()
        log("Scanner browser started")
    }

    var isAvailable: Bool { scanner != nil }

    func requestScan(dpi: Int) {
        guard let scanner = scanner else {
            onScanError?("No scanner found")
            return
        }
        self.scanDPI = dpi
        scanner.requestOpenSession()
    }

    // ICDeviceBrowserDelegate
    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        guard let scannerDevice = device as? ICScannerDevice, scanner == nil else { return }
        scanner = scannerDevice
        scannerDevice.delegate = self
        let name = scannerDevice.name ?? "Unknown Scanner"
        log("Scanner found: \(name)")
        onScannerFound?(name)
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        if let s = scanner, s === device {
            scanner = nil
            log("Scanner removed")
            onScannerRemoved?()
        }
    }

    // ICScannerDeviceDelegate
    func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {
        if let error = error {
            onScanError?("Failed to open session: \(error.localizedDescription)")
            return
        }
        guard let scanner = device as? ICScannerDevice else { return }
        scanner.requestSelect(.flatbed)
    }

    func scannerDevice(_ scanner: ICScannerDevice, didSelect functionalUnit: ICScannerFunctionalUnit, error: Error?) {
        if let error = error {
            onScanError?("Failed to select flatbed: \(error.localizedDescription)")
            return
        }
        let fu = scanner.selectedFunctionalUnit
        fu.pixelDataType = .RGB
        fu.bitDepth = .depth8Bits
        fu.resolution = scanDPI
        fu.measurementUnit = .inches
        let maxSize = fu.physicalSize
        fu.scanArea = NSRect(origin: .zero, size: maxSize)

        onScanProgress?("Scanning at \(scanDPI) DPI...")

        scanner.transferMode = .fileBased
        scanner.downloadsDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
        scanner.documentName = "slabscan_\(Int(Date().timeIntervalSince1970))"
        scanner.documentUTI = "public.jpeg"
        scanner.requestScan()
    }

    func scannerDevice(_ scanner: ICScannerDevice, didScanTo url: URL) {
        guard let imageData = try? Data(contentsOf: url) else {
            onScanError?("Failed to read scanned image")
            return
        }
        // Re-encode JPEG
        guard let image = NSImage(data: imageData),
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let jpeg = bitmap.representation(using: .jpeg,
                  properties: [.compressionFactor: jpegQuality]) else {
            onScanError?("Failed to encode JPEG")
            return
        }
        try? FileManager.default.removeItem(at: url)
        scanner.requestCloseSession()
        onScanComplete?(jpeg)
    }

    func scannerDevice(_ scanner: ICScannerDevice, didCompleteScanWithError error: Error?) {
        if let error = error {
            onScanError?("Scan failed: \(error.localizedDescription)")
            scanner.requestCloseSession()
        }
    }

    func device(_ device: ICDevice, didCloseSessionWithError error: Error?) {}
    func didRemove(_ device: ICDevice) {}
    func device(_ device: ICDevice, didReceiveStatusInformation status: [ICDeviceStatus : Any]) {}
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

class WebSocketServer {
    let listener: NWListener
    let scannerCtl: ScannerController
    var connections: [NWConnection] = []
    let queue = DispatchQueue(label: "ws-server")

    init(port: UInt16, scanner: ScannerController) {
        self.scannerCtl = scanner

        let params = NWParameters(tls: nil)
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host("127.0.0.1"),
            port: NWEndpoint.Port(rawValue: port)!
        )

        do {
            listener = try NWListener(using: params)
        } catch {
            fatalError("Failed to create listener: \(error)")
        }

        // Wire up scanner callbacks
        scannerCtl.onScannerFound = { [weak self] name in
            self?.broadcastJSON(["type": "scan_found", "name": name])
        }
        scannerCtl.onScannerRemoved = { [weak self] in
            self?.broadcastJSON(["type": "scan_removed"])
        }
    }

    func start() {
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                log("WebSocket server listening on 127.0.0.1:\(PORT)")
            case .failed(let err):
                log("Listener failed: \(err)")
                // Try to restart after a delay
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    self?.listener.cancel()
                    // Re-create would be needed here; for now just exit
                    log("Listener failed, exiting for LaunchAgent restart")
                    exit(1)
                }
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] conn in
            self?.handleNewConnection(conn)
        }

        listener.start(queue: queue)
    }

    func handleNewConnection(_ conn: NWConnection) {
        log("New WebSocket connection")
        connections.append(conn)

        conn.stateUpdateHandler = { [weak self] state in
            if case .failed(_) = state { self?.removeConnection(conn) }
            if case .cancelled = state { self?.removeConnection(conn) }
        }

        conn.start(queue: queue)
        receiveMessage(on: conn)
    }

    func removeConnection(_ conn: NWConnection) {
        connections.removeAll { $0 === conn }
        log("Connection removed (\(connections.count) active)")
    }

    func receiveMessage(on conn: NWConnection) {
        conn.receiveMessage { [weak self] content, context, isComplete, error in
            guard let self = self else { return }

            if let error = error {
                log("Receive error: \(error)")
                self.removeConnection(conn)
                return
            }

            if let data = content, let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                self.handleMessage(msg, on: conn)
            }

            // Continue receiving
            self.receiveMessage(on: conn)
        }
    }

    func handleMessage(_ msg: [String: Any], on conn: NWConnection) {
        guard let type = msg["type"] as? String else { return }

        switch type {
        case "hello":
            let response: [String: Any] = [
                "type": "hello",
                "version": "1.0",
                "capabilities": [
                    "scan": scannerCtl.isAvailable,
                    "ocr": true
                ]
            ]
            sendJSON(response, on: conn)
            log("Hello handshake complete (scan: \(scannerCtl.isAvailable))")

        case "ocr":
            guard let id = msg["id"] as? String,
                  let base64 = msg["image_base64"] as? String,
                  let imageData = Data(base64Encoded: base64) else {
                sendJSON(["type": "ocr_result", "id": msg["id"] ?? "", "text": "", "confidence": 0], on: conn)
                return
            }
            // Run OCR on background thread to avoid blocking WebSocket
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let result = recognizeText(imageData: imageData)
                let response: [String: Any] = [
                    "type": "ocr_result",
                    "id": id,
                    "text": result.text,
                    "confidence": result.confidence
                ]
                self?.sendJSON(response, on: conn)
            }

        case "scan_start":
            let params = msg["params"] as? [String: Any]
            let dpi = params?["dpi"] as? Int ?? 300

            // Set up one-shot callbacks for this scan
            scannerCtl.onScanProgress = { [weak self] status in
                self?.sendJSON(["type": "scan_progress", "page": 1, "status": status], on: conn)
            }
            scannerCtl.onScanComplete = { [weak self] jpegData in
                let base64 = jpegData.base64EncodedString()
                self?.sendJSON([
                    "type": "scan_progress",
                    "page": 1,
                    "total_estimate": 1,
                    "image_base64": base64
                ], on: conn)
                self?.sendJSON([
                    "type": "scan_complete",
                    "page_count": 1
                ], on: conn)
            }
            scannerCtl.onScanError = { [weak self] error in
                self?.sendJSON(["type": "scan_error", "error": error], on: conn)
            }

            DispatchQueue.main.async { [weak self] in
                self?.scannerCtl.requestScan(dpi: dpi)
            }

        case "scan_cancel":
            // ImageCaptureCore doesn't have a clean cancel; just log it
            log("Scan cancel requested")

        case "save_file":
            guard let folder = msg["folder"] as? String,
                  let filename = msg["filename"] as? String,
                  let base64 = msg["data"] as? String,
                  let fileData = Data(base64Encoded: base64) else {
                sendJSON(["type": "save_error", "error": "Missing folder, filename, or data"], on: conn)
                return
            }
            let desktop = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Desktop")
                .appendingPathComponent(folder)
            do {
                try FileManager.default.createDirectory(at: desktop, withIntermediateDirectories: true)
                let filePath = desktop.appendingPathComponent(filename)
                try fileData.write(to: filePath)
                sendJSON(["type": "file_saved", "path": filePath.path, "filename": filename], on: conn)
                log("Saved: \(filePath.path)")
            } catch {
                sendJSON(["type": "save_error", "error": "Save failed: \(error.localizedDescription)"], on: conn)
            }

        default:
            log("Unknown message type: \(type)")
        }
    }

    func sendJSON(_ obj: [String: Any], on conn: NWConnection) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "ws", metadata: [metadata])
        conn.send(content: data, contentContext: context, isComplete: true, completion: .idempotent)
    }

    func broadcastJSON(_ obj: [String: Any]) {
        for conn in connections {
            sendJSON(obj, on: conn)
        }
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

setupLogging()
log("SlabScannerHelper starting...")

let scannerCtl = ScannerController()
let server = WebSocketServer(port: PORT, scanner: scannerCtl)

// Start scanner browsing on main thread (required for ImageCaptureCore)
DispatchQueue.main.async {
    scannerCtl.startBrowsing()
}

server.start()

log("Helper running. Press Ctrl+C to stop.")

// Keep the process alive
dispatchMain()
