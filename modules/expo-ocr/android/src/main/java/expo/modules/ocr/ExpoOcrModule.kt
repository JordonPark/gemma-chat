package expo.modules.ocr

import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/** ML Kit (한국어 모델, 앱 포함) 으로 사진 속 글자를 읽는다. 기기 안에서만 처리. */
class ExpoOcrModule : Module() {
  private var recognizer: TextRecognizer? = null

  private fun client(): TextRecognizer =
    recognizer ?: TextRecognition.getClient(KoreanTextRecognizerOptions.Builder().build()).also { recognizer = it }

  override fun definition() = ModuleDefinition {
    Name("ExpoOcr")

    AsyncFunction("recognizeText") { uri: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_OCR", "앱 컨텍스트가 없습니다", null)
        return@AsyncFunction
      }
      val image = try {
        val u = if (uri.startsWith("/")) Uri.fromFile(File(uri)) else Uri.parse(uri)
        InputImage.fromFilePath(context, u) // EXIF 방향 반영
      } catch (e: Exception) {
        promise.reject("ERR_OCR", "이미지를 열 수 없습니다: ${e.message}", e)
        return@AsyncFunction
      }
      val w = image.width.toDouble().coerceAtLeast(1.0)
      val h = image.height.toDouble().coerceAtLeast(1.0)
      client().process(image)
        .addOnSuccessListener { result ->
          val lines = mutableListOf<Map<String, Any>>()
          for (block in result.textBlocks) {
            for (line in block.lines) {
              val r = line.boundingBox
              lines.add(
                mapOf(
                  "text" to line.text,
                  "confidence" to (line.confidence?.toDouble() ?: -1.0),
                  "box" to mapOf(
                    "x" to (r?.left ?: 0) / w,
                    "y" to (r?.top ?: 0) / h,
                    "width" to (r?.width() ?: 0) / w,
                    "height" to (r?.height() ?: 0) / h,
                  ),
                ),
              )
            }
          }
          promise.resolve(mapOf("text" to result.text, "lines" to lines))
        }
        .addOnFailureListener { e -> promise.reject("ERR_OCR", e.message ?: "OCR 실패", e) }
    }

    OnDestroy {
      recognizer?.close()
      recognizer = null
    }
  }
}
