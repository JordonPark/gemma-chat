require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoSd'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/JordonPark/gemma-chat.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreML', 'Accelerate', 'CoreImage', 'CoreGraphics', 'NaturalLanguage', 'ImageIO', 'UniformTypeIdentifiers'

  # StableDiffusion/ : apple/ml-stable-diffusion 의 Swift 소스 (MIT). SD3/T5 파일은 뺐다 (VENDORED.md 참고)
  s.source_files = "**/*.swift"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
