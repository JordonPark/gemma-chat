package expo.modules.ocr

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.Size
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognizer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 실시간 글자 스캔 화면 (CameraX 미리보기 + ML Kit 한국어 인식).
 * 사진을 찍지 않고 미리보기 화면을 그대로 읽으므로 셔터 소리가 없고 사진도 남지 않는다.
 * '읽기'를 누르면 지금 화면에서 읽은 글자를 돌려준다.
 */
class TextScanDialog(
  private val activity: Activity,
  private val recognizer: TextRecognizer,
  private val onFinish: (String?) -> Unit,
) : Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen) {

  private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val busy = AtomicBoolean(false)
  private var finished = false
  private var cameraProvider: ProcessCameraProvider? = null
  @Volatile private var latestText: String = ""
  private lateinit var preview: TextView

  private fun dp(v: Int) =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), activity.resources.displayMetrics).toInt()

  init {
    val root = FrameLayout(activity)
    val previewView = PreviewView(activity).apply {
      scaleType = PreviewView.ScaleType.FILL_CENTER
    }
    root.addView(previewView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    val bar = LinearLayout(activity).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(16), dp(14), dp(16), dp(14))
      background = GradientDrawable().apply {
        setColor(Color.argb(170, 0, 0, 0))
        cornerRadius = dp(18).toFloat()
      }
    }
    preview = TextView(activity).apply {
      setTextColor(Color.WHITE)
      textSize = 14f
      maxLines = 4
      text = "글자에 카메라를 대 주세요. 사진은 찍지 않습니다."
    }
    bar.addView(preview)

    val row = LinearLayout(activity).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(0, dp(10), 0, 0)
    }
    val cancel = Button(activity).apply {
      text = "취소"
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.TRANSPARENT)
      setOnClickListener { finish(null) }
    }
    val spacer = android.view.View(activity)
    val read = Button(activity).apply {
      text = "읽기"
      setTextColor(Color.WHITE)
      background = GradientDrawable().apply {
        setColor(Color.rgb(130, 84, 219))
        cornerRadius = dp(14).toFloat()
      }
      setPadding(dp(28), dp(10), dp(28), dp(10))
      setOnClickListener {
        val t = latestText.trim()
        if (t.isEmpty()) {
          preview.text = "아직 읽은 글자가 없어요. 글자에 조금 더 가까이 대 보세요."
        } else {
          finish(t)
        }
      }
    }
    row.addView(cancel)
    row.addView(spacer, LinearLayout.LayoutParams(0, 1, 1f))
    row.addView(read)
    bar.addView(row)

    val barParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
      gravity = Gravity.BOTTOM
      setMargins(dp(12), dp(12), dp(12), dp(28))
    }
    root.addView(bar, barParams)
    setContentView(root)
    setOnCancelListener { finish(null) } // 뒤로 가기

    startCamera(previewView)
  }

  private fun startCamera(previewView: PreviewView) {
    val owner = activity as? LifecycleOwner
    if (owner == null) {
      finish(null)
      return
    }
    val future = ProcessCameraProvider.getInstance(activity)
    future.addListener({
      try {
        val provider = future.get()
        cameraProvider = provider
        val previewUseCase = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
        val analysis = ImageAnalysis.Builder()
          .setResolutionSelector(
            ResolutionSelector.Builder()
              .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
              .build(),
          )
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
          .build()
        analysis.setAnalyzer(analysisExecutor) { proxy ->
          // 앞 프레임을 읽는 중이면 건너뛴다 (가장 최근 화면만 읽음)
          if (!busy.compareAndSet(false, true)) {
            proxy.close()
            return@setAnalyzer
          }
          val rotation = proxy.imageInfo.rotationDegrees
          val bitmap = try {
            proxy.toBitmap()
          } catch (e: Exception) {
            null
          } finally {
            proxy.close()
          }
          if (bitmap == null) {
            busy.set(false)
            return@setAnalyzer
          }
          recognizer.process(InputImage.fromBitmap(bitmap, rotation))
            .addOnSuccessListener { result ->
              latestText = result.text
              val lines = result.textBlocks.sumOf { it.lines.size }
              preview.post {
                preview.text = if (lines == 0) {
                  "글자에 카메라를 대 주세요. 사진은 찍지 않습니다."
                } else {
                  "${lines}줄 읽는 중 · '읽기'를 누르면 가져옵니다\n${result.text.take(160)}"
                }
              }
            }
            .addOnCompleteListener { busy.set(false) }
        }
        provider.unbindAll()
        provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, analysis)
      } catch (e: Exception) {
        preview.text = "카메라를 열 수 없습니다: ${e.message}"
      }
    }, ContextCompat.getMainExecutor(activity))
  }

  private fun finish(text: String?) {
    if (finished) return
    finished = true
    try {
      cameraProvider?.unbindAll()
    } catch (_: Exception) {
    }
    analysisExecutor.shutdown()
    if (isShowing) dismiss()
    onFinish(text)
  }
}
