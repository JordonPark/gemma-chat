import ExpoModulesCore
import ImageIO
import Vision

/// Apple Vision 으로 사진 속 글자를 읽는다 (한국어 + 영어, 정확도 우선, 기기 안에서만 처리).
public final class ExpoOcrModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoOcr")

    AsyncFunction("recognizeText") { (uri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try ExpoOcrModule.recognize(uri: uri))
        } catch {
          promise.reject("ERR_OCR", error.localizedDescription)
        }
      }
    }
  }

  private struct OcrError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  private static func recognize(uri: String) throws -> [String: Any] {
    let url: URL
    if let u = URL(string: uri), u.scheme != nil {
      url = u
    } else {
      url = URL(fileURLWithPath: uri)
    }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
      throw OcrError(message: "이미지를 열 수 없습니다: \(uri)")
    }
    // EXIF 방향 반영 (회전된 사진도 바르게 읽도록)
    var orientation = CGImagePropertyOrientation.up
    if let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
       let raw = props[kCGImagePropertyOrientation] as? UInt32,
       let o = CGImagePropertyOrientation(rawValue: raw) {
      orientation = o
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    let wanted = ["ko-KR", "en-US"].filter { supported.contains($0) }
    if !wanted.isEmpty {
      request.recognitionLanguages = wanted
    }
    if #available(iOS 16.0, *) {
      request.automaticallyDetectsLanguage = wanted.isEmpty
    }

    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
    try handler.perform([request])

    var lines: [[String: Any]] = []
    for obs in request.results ?? [] {
      guard let best = obs.topCandidates(1).first else { continue }
      let b = obs.boundingBox // 0~1, 왼쪽 아래 원점
      lines.append([
        "text": best.string,
        "confidence": Double(best.confidence),
        "box": [
          "x": Double(b.origin.x),
          "y": Double(1 - b.origin.y - b.size.height),
          "width": Double(b.size.width),
          "height": Double(b.size.height),
        ],
      ])
    }
    // 위→아래, 같은 줄이면 왼쪽→오른쪽
    lines.sort { a, b in
      let ba = a["box"] as! [String: Double], bb = b["box"] as! [String: Double]
      let ya = ba["y"]!, yb = bb["y"]!
      let rowTolerance = min(ba["height"]!, bb["height"]!) * 0.5
      if abs(ya - yb) > rowTolerance { return ya < yb }
      return ba["x"]! < bb["x"]!
    }
    let text = lines.compactMap { $0["text"] as? String }.joined(separator: "\n")
    return ["text": text, "lines": lines]
  }
}
