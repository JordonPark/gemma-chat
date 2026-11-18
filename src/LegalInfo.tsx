import { Alert, Linking, Platform, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { APP_NAME, SUPPORT_BASE_URL } from './storeConfig';
import legal from './legalDocuments.json';
import licenses from '../licenses/modelLicenses.json';
import { colors } from './theme';

const documents = [
  { name: '개인정보처리방침', text: legal.privacy },
  { name: '이용약관', text: legal.terms },
  { name: 'Gemma 라이선스', text: licenses.gemmaTerms },
  { name: 'Gemma 금지 사용 정책', text: licenses.gemmaProhibitedUse },
];

export function LegalInfo() {
  const [document, setDocument] = useState<typeof documents[number] | null>(null);
  const openPage = (path: '/privacy' | '/support') => {
    Linking.openURL(`${SUPPORT_BASE_URL}${path}`).catch(() => Alert.alert('페이지를 열 수 없습니다.'));
  };

  return (
    <View style={styles.links}>
      {documents.map((item) => (
        <Pressable key={item.name} accessibilityRole="button" style={styles.link} onPress={() => setDocument(item)}>
          <Text style={styles.linkText}>{item.name}</Text>
        </Pressable>
      ))}
      {SUPPORT_BASE_URL ? (
        <Pressable accessibilityRole="link" style={styles.link} onPress={() => openPage('/support')}>
          <Text style={styles.linkText}>개인정보 문의 및 삭제 요청</Text>
        </Pressable>
      ) : null}
      {document ? (
        <Modal presentationStyle="pageSheet" animationType="slide" onRequestClose={() => setDocument(null)}>
          <SafeAreaProvider>
            <SafeAreaView style={styles.screen}>
              <View style={styles.header}>
                <Text accessibilityRole="header" style={styles.title}>{document.name}</Text>
                <Pressable accessibilityRole="button" style={styles.link} onPress={() => setDocument(null)}>
                  <Text style={styles.linkText}>닫기</Text>
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={styles.document}>
                <Text selectable style={styles.body}>{document.text}</Text>
                {document.name === '개인정보처리방침' && SUPPORT_BASE_URL ? (
                  <>
                    <Pressable accessibilityRole="link" style={styles.link} onPress={() => openPage('/privacy')}>
                      <Text style={styles.linkText}>웹에서 개인정보처리방침 보기</Text>
                    </Pressable>
                    <Pressable accessibilityRole="link" style={styles.link} onPress={() => openPage('/support')}>
                      <Text style={styles.linkText}>개인정보 문의 및 삭제 요청</Text>
                    </Pressable>
                  </>
                ) : null}
              </ScrollView>
            </SafeAreaView>
          </SafeAreaProvider>
        </Modal>
      ) : null}
    </View>
  );
}

export function LegalConsent({ onAccept }: { onAccept: () => void }) {
  return (
    <ScrollView contentContainerStyle={styles.consent}>
      <Text accessibilityRole="header" style={styles.title}>{APP_NAME} 이용 안내</Text>
      <Text style={styles.body}>
        대화와 사진은 기기에서 처리됩니다. 모델을 사용하려면 이용약관과 해당 모델의 사용 제한에 동의해 주세요.
      </Text>
      <LegalInfo />
      <Pressable style={styles.primary} accessibilityRole="button" onPress={onAccept}>
        <Text style={styles.primaryText}>이용약관 및 모델 사용 제한에 동의하고 계속</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  consent: { padding: 22, gap: 16, width: '100%', maxWidth: 560, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: Platform.OS === 'ios' ? 12 : 0 },
  title: { fontSize: 20, color: colors.text, fontWeight: '800', flexShrink: 1 },
  links: { gap: 4, alignItems: 'flex-start' },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 },
  linkText: { color: colors.accentText, fontWeight: '700', fontSize: 15 },
  document: { padding: 18, gap: 14 },
  body: { fontSize: 15, lineHeight: 23, color: colors.text },
  primary: { alignItems: 'center', backgroundColor: colors.accent, borderRadius: 12, padding: 14 },
  primaryText: { color: '#fff', fontWeight: '700', textAlign: 'center' },
});
