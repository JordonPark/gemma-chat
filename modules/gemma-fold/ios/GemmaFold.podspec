Pod::Spec.new do |s|
  s.name = 'GemmaFold'
  s.version = '1.0.0'
  s.summary = 'Reports active iOS display divisions to Gemma Chat'
  s.license = 'MIT'
  s.author = 'gemma-chat'
  s.homepage = 'https://github.com/JordonPark/gemma-chat'
  s.source = { git: 'https://github.com/JordonPark/gemma-chat.git' }
  s.platforms = { ios: '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.{h,m,swift}'
  s.public_header_files = 'GemmaFoldGeometry.h'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
