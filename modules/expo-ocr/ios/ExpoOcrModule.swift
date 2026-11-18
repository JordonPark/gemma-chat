import ExpoModulesCore
import ImageIO
import UIKit
import MediaPipeTasksVision
import Vision
import VisionKit

/// Apple Vision 으로 사진 속 글자를 읽는다 (한국어 + 영어, 정확도 우선, 기기 안에서만 처리).
public final class ExpoOcrModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoOcr")

    /// 사진 속 물건(일상 물건 80종) 위치·이름 (MediaPipe EfficientDet-Lite0, 앱에 포함된 4.6MB 모델, 기기 안에서만)
    AsyncFunction("detectObjects") { (uri: String, promise: Promise) in
      ExpoOcrModule.detectQueue.async {
        do {
          promise.resolve(try ExpoOcrModule.detect(uri: uri))
        } catch {
          promise.reject("ERR_DETECT", error.localizedDescription)
        }
      }
    }

    AsyncFunction("recognizeText") { (uri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try ExpoOcrModule.recognize(uri: uri))
        } catch {
          promise.reject("ERR_OCR", error.localizedDescription)
        }
      }
    }

    /// 이 기기에서 실시간 글자 스캔을 쓸 수 있는지 (iOS 16+, A12 칩 이상)
    AsyncFunction("isScanSupported") { () -> Bool in
      MainActor.assumeIsolated {
        guard #available(iOS 16.0, *) else { return false }
        return DataScannerViewController.isSupported
      }
    }.runOnQueue(.main)

    /// 실시간 글자 스캔 화면을 띄우고, 읽은 글자를 돌려준다 (취소하면 nil).
    /// 사진을 찍지 않으므로 셔터 소리가 없고 사진도 남지 않는다.
    AsyncFunction("scanText") { (promise: Promise) in
      MainActor.assumeIsolated {
        self.presentScanner(promise)
      }
    }.runOnQueue(.main)
  }

  @MainActor
  private func presentScanner(_ promise: Promise) {
    guard #available(iOS 16.0, *), DataScannerViewController.isSupported else {
      promise.reject("ERR_SCAN_UNSUPPORTED", "이 기기에서는 실시간 글자 스캔을 쓸 수 없습니다. 앨범에서 사진을 골라 주세요.")
      return
    }
    guard DataScannerViewController.isAvailable else {
      promise.reject("ERR_SCAN_UNAVAILABLE", "카메라를 쓸 수 없습니다. 설정에서 카메라 권한을 허용해 주세요.")
      return
    }
    guard let presenter = appContext?.utilities?.currentViewController() else {
      promise.reject("ERR_SCAN", "화면을 열 수 없습니다.")
      return
    }
    let supported = DataScannerViewController.supportedTextRecognitionLanguages
    let languages = ["ko-KR", "en-US"].filter { supported.contains($0) }
    let vc = TextScanController(languages: languages)
    vc.onFinish = { text in promise.resolve(text) }
    presenter.present(vc, animated: true)
  }

  // MARK: - 물체 인식

  private static let detectQueue = DispatchQueue(label: "expo.ocr.detect", qos: .userInitiated)
  /// detectQueue 에서만 만들고 쓴다
  nonisolated(unsafe) private static var detector: ObjectDetector?

  private static func modelPath() -> String? {
    let candidates = [Bundle.main, Bundle(for: ExpoOcrModule.self)]
    for b in candidates {
      if let url = b.url(forResource: "ExpoOcrModels", withExtension: "bundle"),
         let bundle = Bundle(url: url),
         let p = bundle.path(forResource: "efficientdet_lite0", ofType: "tflite") {
        return p
      }
      if let p = b.path(forResource: "efficientdet_lite0", ofType: "tflite") { return p }
    }
    return nil
  }

  private static func objectDetector() throws -> ObjectDetector {
    if let d = detector { return d }
    guard let path = modelPath() else { throw OcrError(message: "물체 인식 모델 파일을 찾을 수 없습니다.") }
    let options = ObjectDetectorOptions()
    options.baseOptions.modelAssetPath = path
    options.runningMode = .image
    options.maxResults = 8
    options.scoreThreshold = 0.35
    let d = try ObjectDetector(options: options)
    detector = d
    return d
  }

  private static func detect(uri: String) throws -> [[String: Any]] {
    let url: URL
    if let u = URL(string: uri), u.scheme != nil { url = u } else { url = URL(fileURLWithPath: uri) }
    guard let image = UIImage(contentsOfFile: url.path), let cg = image.cgImage else {
      throw OcrError(message: "이미지를 열 수 없습니다: \(uri)")
    }
    let result = try objectDetector().detect(image: try MPImage(uiImage: image))
    let w = Double(cg.width), h = Double(cg.height)
    return result.detections.compactMap { d in
      guard let c = d.categories.first, let name = c.categoryName, !name.isEmpty else { return nil }
      let b = d.boundingBox
      return [
        "label": name,
        "score": Double(c.score),
        "box": [
          "x": max(0, Double(b.origin.x) / w),
          "y": max(0, Double(b.origin.y) / h),
          "width": min(1, Double(b.size.width) / w),
          "height": min(1, Double(b.size.height) / h),
        ],
      ]
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
