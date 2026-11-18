import UIKit
import VisionKit

/// 실시간 글자 스캔 화면 (Apple VisionKit DataScanner).
/// 사진을 찍지 않고 카메라 화면에서 바로 글자를 읽으므로 셔터 소리가 나지 않고, 사진도 저장되지 않는다.
/// - 글자를 누르면 그 줄만 고른다 (다시 누르면 해제). 아무것도 고르지 않으면 화면에 보이는 글자 전체를 읽는다.
@available(iOS 16.0, *)
final class TextScanController: UIViewController, DataScannerViewControllerDelegate {
  /// 끝나면 한 번 호출된다. nil = 취소
  var onFinish: ((String?) -> Void)?

  private let scanner: DataScannerViewController
  private var items: [UUID: (text: String, bounds: RecognizedItem.Bounds)] = [:]
  private var selected: [UUID] = []
  private let hint = UILabel()
  private let readButton = UIButton(type: .system)
  private var finished = false

  init(languages: [String]) {
    scanner = DataScannerViewController(
      recognizedDataTypes: [.text(languages: languages)],
      qualityLevel: .accurate,
      recognizesMultipleItems: true,
      isHighFrameRateTrackingEnabled: false,
      isPinchToZoomEnabled: true,
      isGuidanceEnabled: true,
      isHighlightingEnabled: true
    )
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    addChild(scanner)
    scanner.view.frame = view.bounds
    scanner.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(scanner.view)
    scanner.didMove(toParent: self)
    scanner.delegate = self

    let bar = UIStackView()
    bar.axis = .vertical
    bar.spacing = 12
    bar.translatesAutoresizingMaskIntoConstraints = false
    bar.isLayoutMarginsRelativeArrangement = true
    bar.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16)
    bar.backgroundColor = UIColor.black.withAlphaComponent(0.6)
    bar.layer.cornerRadius = 18

    hint.textColor = .white
    hint.font = .systemFont(ofSize: 14)
    hint.numberOfLines = 2
    hint.textAlignment = .center
    updateHint()

    let cancel = UIButton(type: .system)
    cancel.setTitle("취소", for: .normal)
    cancel.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
    cancel.tintColor = .white
    cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

    readButton.setTitle("읽기", for: .normal)
    readButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .bold)
    readButton.tintColor = .white
    readButton.backgroundColor = UIColor(red: 0.51, green: 0.33, blue: 0.86, alpha: 1)
    readButton.layer.cornerRadius = 14
    readButton.contentEdgeInsets = UIEdgeInsets(top: 12, left: 28, bottom: 12, right: 28)
    readButton.addTarget(self, action: #selector(readTapped), for: .touchUpInside)

    let buttons = UIStackView(arrangedSubviews: [cancel, UIView(), readButton])
    buttons.axis = .horizontal
    buttons.alignment = .center

    bar.addArrangedSubview(hint)
    bar.addArrangedSubview(buttons)
    view.addSubview(bar)
    NSLayoutConstraint.activate([
      bar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
      bar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
      bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
    ])
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    do {
      try scanner.startScanning()
    } catch {
      finish(nil, error: error)
    }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    scanner.stopScanning()
  }

  // MARK: - 인식 결과 추적

  private func store(_ list: [RecognizedItem]) {
    for item in list {
      if case .text(let t) = item {
        items[item.id] = (t.transcript, item.bounds)
      }
    }
  }

  func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    store(addedItems)
    updateHint()
  }

  func dataScanner(_ dataScanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    store(updatedItems)
  }

  func dataScanner(_ dataScanner: DataScannerViewController, didRemove removedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    for item in removedItems where !selected.contains(item.id) {
      items.removeValue(forKey: item.id)
    }
    updateHint()
  }

  func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
    guard case .text(let t) = item else { return }
    items[item.id] = (t.transcript, item.bounds)
    if let i = selected.firstIndex(of: item.id) {
      selected.remove(at: i)
    } else {
      selected.append(item.id)
    }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    updateHint()
  }

  private func updateHint() {
    if !selected.isEmpty {
      hint.text = "\(selected.count)줄 골랐어요. '읽기'를 누르면 고른 글자만 가져옵니다."
    } else if items.isEmpty {
      hint.text = "글자에 카메라를 대 주세요. 사진은 찍지 않습니다."
    } else {
      hint.text = "'읽기'를 누르면 보이는 글자를 모두 가져옵니다. 글자를 눌러 일부만 고를 수도 있어요."
    }
  }

  // MARK: - 버튼

  @objc private func cancelTapped() { finish(nil) }

  @objc private func readTapped() {
    let ids = selected.isEmpty ? Array(items.keys) : selected
    var picked = ids.compactMap { id in items[id] }
    if selected.isEmpty {
      // 위→아래, 같은 줄이면 왼쪽→오른쪽
      picked.sort { a, b in
        let ya = a.bounds.topLeft.y, yb = b.bounds.topLeft.y
        let h = min(abs(a.bounds.bottomLeft.y - ya), abs(b.bounds.bottomLeft.y - yb)) * 0.5
        if abs(ya - yb) > max(h, 4) { return ya < yb }
        return a.bounds.topLeft.x < b.bounds.topLeft.x
      }
    }
    let text = picked.map { $0.text }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty {
      hint.text = "아직 읽은 글자가 없어요. 글자에 조금 더 가까이 대 보세요."
      UINotificationFeedbackGenerator().notificationOccurred(.warning)
      return
    }
    finish(text)
  }

  private func finish(_ text: String?, error: Error? = nil) {
    guard !finished else { return }
    finished = true
    scanner.stopScanning()
    dismiss(animated: true) { [onFinish] in onFinish?(text) }
  }
}
