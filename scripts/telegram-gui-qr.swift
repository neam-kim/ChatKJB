import AppKit
import CoreImage
import Foundation

let message = FileHandle.standardInput.readDataToEndOfFile()
guard !message.isEmpty else {
    fputs("QR input is empty\n", stderr)
    exit(65)
}

guard let filter = CIFilter(name: "CIQRCodeGenerator") else {
    fputs("Core Image QR generator is unavailable\n", stderr)
    exit(69)
}
filter.setValue(message, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")

guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else {
    fputs("QR generation failed\n", stderr)
    exit(70)
}
let context = CIContext(options: [.useSoftwareRenderer: false])
guard let image = context.createCGImage(output, from: output.extent) else {
    fputs("QR image rendering failed\n", stderr)
    exit(70)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let imageView = NSImageView(frame: NSRect(x: 24, y: 24, width: 350, height: 350))
imageView.image = NSImage(cgImage: image, size: NSSize(width: 350, height: 350))
imageView.imageScaling = .scaleProportionallyUpOrDown
let window = NSWindow(
    contentRect: NSRect(x: 0, y: 0, width: 398, height: 398),
    styleMask: [.titled],
    backing: .buffered,
    defer: false
)
window.title = "ChatKJB Terminal · Telegram Login"
window.level = .floating
window.contentView = imageView
window.center()
window.makeKeyAndOrderFront(nil)
application.activate(ignoringOtherApps: true)
print("READY \(window.windowNumber)")
fflush(stdout)
application.run()
