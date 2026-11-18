import ExpoModulesCore
import UIKit

public final class GemmaFoldModule: Module {
  public func definition() -> ModuleDefinition {
    Name("GemmaFold")

    View(FoldObserverView.self) {
      Events("onGeometryChange")
    }
  }
}

final class FoldObserverView: ExpoView {
  let onGeometryChange = EventDispatcher()
  private var lastSize = CGSize.zero
  private var lastDivision = CGRect.null

  override class var requiresConstraintBasedLayout: Bool { true }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    setNeedsUpdateConstraints()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if lastSize != bounds.size {
      setNeedsUpdateConstraints()
    }
  }

  override func updateConstraints() {
    // UIKit tracks reserved-region reads during this pass and invalidates them as the fold changes.
    if window != nil, !bounds.isEmpty {
      let size = bounds.size
      let division = GemmaActiveDivisionFrame(self)
      if size != lastSize || division != lastDivision {
        lastSize = size
        lastDivision = division
        var geometry: [String: Any] = ["width": size.width, "height": size.height]
        if !division.isNull {
          geometry["division"] = [
            "x": division.minX, "y": division.minY,
            "width": division.width, "height": division.height
          ]
        }
        onGeometryChange(geometry)
      }
    }
    super.updateConstraints()
  }
}
