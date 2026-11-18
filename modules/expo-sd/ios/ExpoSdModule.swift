import CoreGraphics
import CoreML
import ExpoModulesCore
import ImageIO
import UniformTypeIdentifiers

struct SdGenerateOptions: Record {
  @Field var prompt: String = ""
  @Field var negativePrompt: String = ""
  @Field var steps: Int = 25
  @Field var guidance: Double = 7.5
  /// 음수면 무작위
  @Field var seed: Int = -1
  /// 결과 PNG 를 쓸 경로 (file:// 또는 절대 경로)
  @Field var outputPath: String = ""
}

/// Apple Core ML Stable Diffusion (Neural Engine). 기기 안에서만 그림을 만든다.
public final class ExpoSdModule: Module {
  private var pipeline: StableDiffusionPipeline?
  private var loadedPath: String?
  private var cancelRequested = false
  private let queue = DispatchQueue(label: "expo.sd.pipeline", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("ExpoSd")
    Events("onProgress")

    /// 리소스 폴더(TextEncoder.mlmodelc, Unet.mlmodelc, VAEDecoder.mlmodelc, vocab.json, merges.txt …)로 파이프라인 준비.
    /// 처음 한 번은 Neural Engine 용으로 컴파일하느라 1~3분 걸릴 수 있다 (이후 iOS 가 캐시).
    AsyncFunction("load") { (resourcesPath: String, promise: Promise) in
      self.queue.async {
        do {
          let path = ExpoSdModule.filePath(resourcesPath)
          if self.loadedPath == path, self.pipeline != nil {
            promise.resolve(nil)
            return
          }
          self.pipeline?.unloadResources()
          self.pipeline = nil
          let config = MLModelConfiguration()
          config.computeUnits = .cpuAndNeuralEngine
          let p = try StableDiffusionPipeline(
            resourcesAt: URL(fileURLWithPath: path),
            controlNet: [],
            configuration: config,
            disableSafety: false,
            reduceMemory: true
          )
          try p.loadResources()
          self.pipeline = p
          self.loadedPath = path
          promise.resolve(nil)
        } catch {
          promise.reject("ERR_SD_LOAD", "이미지 모델을 불러오지 못했습니다: \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("generate") { (options: SdGenerateOptions, promise: Promise) in
      self.queue.async {
        guard let pipeline = self.pipeline else {
          promise.reject("ERR_SD_NOT_LOADED", "이미지 모델이 로드되지 않았습니다.")
          return
        }
        self.cancelRequested = false
        do {
          var cfg = StableDiffusionPipeline.Configuration(prompt: options.prompt)
          cfg.negativePrompt = options.negativePrompt
          cfg.stepCount = max(4, min(options.steps, 50))
          cfg.guidanceScale = Float(options.guidance)
          cfg.seed = options.seed >= 0 ? UInt32(truncatingIfNeeded: options.seed) : UInt32.random(in: 0...UInt32.max)
          cfg.schedulerType = .dpmSolverMultistepScheduler
          cfg.disableSafety = false

          let images = try pipeline.generateImages(configuration: cfg) { progress in
            self.sendEvent("onProgress", [
              "step": progress.step + 1,
              "stepCount": progress.stepCount,
            ])
            return !self.cancelRequested
          }
          if self.cancelRequested {
            promise.reject("ERR_SD_CANCELLED", "그리기를 취소했습니다.")
            return
          }
          guard let image = images.first ?? nil else {
            promise.reject("ERR_SD_UNSAFE", "안전 검사에서 걸러졌습니다. 다른 설명으로 다시 시도해 주세요.")
            return
          }
          let out = ExpoSdModule.filePath(options.outputPath)
          try ExpoSdModule.writePNG(image, to: out)
          promise.resolve(["uri": URL(fileURLWithPath: out).absoluteString, "seed": Int(cfg.seed)])
        } catch {
          promise.reject("ERR_SD_GENERATE", "그림 생성 실패: \(error.localizedDescription)")
        }
      }
    }

    Function("cancel") {
      self.cancelRequested = true
    }

    /// 메모리 반환 (채팅 모델을 다시 올리기 전에 호출)
    AsyncFunction("unload") { (promise: Promise) in
      self.queue.async {
        self.pipeline?.unloadResources()
        self.pipeline = nil
        self.loadedPath = nil
        promise.resolve(nil)
      }
    }
  }

  private static func filePath(_ s: String) -> String {
    if let u = URL(string: s), u.isFileURL { return u.path }
    return s
  }

  private static func writePNG(_ image: CGImage, to path: String) throws {
    let url = URL(fileURLWithPath: path)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
      throw NSError(domain: "ExpoSd", code: 1, userInfo: [NSLocalizedDescriptionKey: "PNG 파일을 만들 수 없습니다"])
    }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) {
      throw NSError(domain: "ExpoSd", code: 2, userInfo: [NSLocalizedDescriptionKey: "PNG 저장 실패"])
    }
  }
}
